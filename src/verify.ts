/**
 * verify —— 对清单里的能力做端到端验证。
 *
 * 为什么需要它：
 *   `tako capture` 与 `tako add` 都会往清单里塞动词，而这些动词从没被跑过。
 *   「写进清单了」和「真能跑」之间隔着一堆现实问题：令牌没配、baseUrl 写错、
 *   缺少必填参数、脚本路径不对、browser 驱动没装。verify 就是那道门。
 *
 * 两档，默认最保守：
 *   · 静态（默认）：不产生任何副作用 —— 连接、鉴权、步骤、脚本、参数可满足性
 *   · --live：真的调用一次，让「写进清单」变成「验证过」
 *
 * 安全性是硬约束，不是提示：
 *   GET 之外的 verb 默认不跑；要跑 write 必须 --include-write；
 *   destructive 必须 --include-write 且 --yes 才跑。verify 自己不该成为最危险的东西。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { probeBrowserPlugin } from './driver.js';
import { resolveParams } from './run.js';
import { execute } from './run.js';
import type { Manifest, ParameterValues, RiskLevel, Verb } from './types.js';

export type VerifyStatus = 'pass' | 'fail' | 'skip';

export interface VerifyCheck {
  name: string;
  status: VerifyStatus;
  detail: string;
}

export interface VerifyReport {
  verb: string;
  arm: string;
  risk: RiskLevel;
  mode: 'static' | 'live';
  status: VerifyStatus;
  durationMs?: number;
  checks: VerifyCheck[];
  error?: string;
}

export interface VerifyOptions {
  /** 真的调用（默认只做静态体检） */
  live?: boolean;
  /** 允许调用 write 级动词 */
  includeWrite?: boolean;
  /** destructive 级动词的双重确认 */
  confirmed?: boolean;
  /** 喂给所有被验证动词的入参（简单起见，全局共用一份） */
  params?: ParameterValues;
  /** 环境变量快照，便于测试；默认取 process.env */
  env?: Readonly<Record<string, string | undefined>>;
}

export async function verifyManifest(
  manifest: Manifest,
  options: VerifyOptions = {},
): Promise<VerifyReport[]> {
  return verifyVerbs(manifest, manifest.verbs, options);
}

/** 指定动词子集做验证（CLI 的 `tako verify <verb>...` 用这个） */
export async function verifyVerbs(
  manifest: Manifest,
  verbs: readonly Verb[],
  options: VerifyOptions = {},
): Promise<VerifyReport[]> {
  const reports: VerifyReport[] = [];
  // browser 驱动探测一次就够，不必每个动词各查一遍
  const browserArms = new Set(
    manifest.arms.filter((arm) => arm.adapter === 'browser').map((arm) => arm.name),
  );
  const browserPluginMissing = new Set<string>();

  if (browserArms.size > 0) {
    const report = await probeBrowserPlugin(manifest.dir);
    if (!report.plugin) for (const name of browserArms) browserPluginMissing.add(name);
  }

  for (const verb of verbs) {
    reports.push(await verifyVerb(manifest, verb, { ...options, browserPluginMissing }));
  }
  return reports;
}

interface InternalOptions extends VerifyOptions {
  browserPluginMissing?: Set<string>;
}

async function verifyVerb(
  manifest: Manifest,
  verb: Verb,
  options: InternalOptions,
): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const arm = manifest.armByName.get(verb.arm);

  // ── 静态：连接与适配器 ──
  if (!arm) {
    checks.push({ name: '连接', status: 'fail', detail: `引用了不存在的 arm：${verb.arm}` });
  } else {
    checks.push({ name: '连接', status: 'pass', detail: `${arm.name} (${arm.adapter})` });
  }

  if (arm?.adapter === 'http') {
    checks.push(
      arm.baseUrl
        ? { name: 'baseUrl', status: 'pass', detail: arm.baseUrl }
        : { name: 'baseUrl', status: 'fail', detail: 'arm 缺少 baseUrl' },
    );

    if (arm.auth.type !== 'none') {
      const envName = arm.auth.tokenEnv;
      const hasToken = envName ? Boolean((options.env ?? process.env)[envName]) : false;
      checks.push({
        name: '鉴权',
        status: hasToken ? 'pass' : 'fail',
        detail: hasToken
          ? `${envName} 已设置`
          : `环境变量 ${envName ?? '（未声明 tokenEnv）'} 未设置`,
      });
    }
  }

  if (arm?.adapter === 'script') {
    const script = verb.action.script;
    if (!script) {
      checks.push({ name: '脚本', status: 'fail', detail: '没有声明 action.script' });
    } else {
      const resolved = path.resolve(manifest.dir, script);
      const inside = resolved.startsWith(manifest.dir);
      checks.push(
        !inside
          ? { name: '脚本', status: 'fail', detail: `脚本越出清单目录：${script}` }
          : existsSync(resolved)
            ? { name: '脚本', status: 'pass', detail: path.relative(manifest.dir, resolved) }
            : { name: '脚本', status: 'fail', detail: `脚本不存在：${resolved}` },
      );
    }
  }

  if (arm?.adapter === 'browser') {
    const stepCount = verb.action.steps?.length ?? 0;
    checks.push(
      stepCount > 0
        ? { name: '步骤', status: 'pass', detail: `${stepCount} 个步骤` }
        : { name: '步骤', status: 'fail', detail: 'browser 动词没有声明 action.steps' },
    );
    if (options.browserPluginMissing?.has(verb.arm)) {
      checks.push({
        name: 'browser 驱动',
        status: 'fail',
        detail: '未找到驱动插件（tako doctor 会列出找过哪些位置）',
      });
    }
  }

  // ── 静态：参数可满足性（静态模式下不调用，就不存在「缺参数」这回事）──
  const { values: _values, missing } = resolveParams(verb, options.params ?? {});
  const paramDetail = describeParams(verb, missing, Boolean(options.live));
  checks.push({
    name: '参数',
    status: paramDetail.status,
    detail: paramDetail.detail,
  });

  const staticFailed = checks.some((check) => check.status === 'fail');

  if (!options.live) {
    return {
      verb: verb.name,
      arm: verb.arm,
      risk: verb.risk,
      mode: 'static',
      status: staticFailed ? 'fail' : 'pass',
      checks,
    };
  }

  // ── live：先过安全闸门，再真的调用 ──
  const gate = liveGate(verb, options);
  if (gate) {
    checks.push({ name: 'live', status: 'skip', detail: gate });
    return {
      verb: verb.name,
      arm: verb.arm,
      risk: verb.risk,
      mode: 'live',
      status: 'skip',
      checks,
    };
  }

  if (missing.length > 0) {
    return {
      verb: verb.name,
      arm: verb.arm,
      risk: verb.risk,
      mode: 'live',
      status: 'skip',
      checks,
    };
  }

  const startedAt = Date.now();
  try {
    const result = await execute(manifest, verb, options.params ?? {}, {});
    checks.push({
      name: 'live',
      status: 'pass',
      detail: result.status ? `HTTP ${result.status}` : `${result.durationMs ?? 0}ms`,
    });
    return {
      verb: verb.name,
      arm: verb.arm,
      risk: verb.risk,
      mode: 'live',
      status: 'pass',
      durationMs: Date.now() - startedAt,
      checks,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ name: 'live', status: 'fail', detail: firstLine(message) });
    return {
      verb: verb.name,
      arm: verb.arm,
      risk: verb.risk,
      mode: 'live',
      status: 'fail',
      durationMs: Date.now() - startedAt,
      checks,
      error: message,
    };
  }
}

/**
 * 参数检查的语义随模式变：
 *   静态模式不调用，所以「必填参数没给」不是问题，只告知需要准备什么；
 *   live 模式才真需要，缺了就只能跳过，并把补齐方式写清楚。
 */
function describeParams(
  verb: Verb,
  missing: readonly string[],
  live: boolean,
): { status: VerifyStatus; detail: string } {
  const required = verb.params.filter((param) => param.required).map((param) => param.name);

  if (required.length === 0) return { status: 'pass', detail: '无必填参数' };

  if (missing.length === 0) {
    return { status: 'pass', detail: `必填参数齐备：${required.join(', ')}` };
  }

  if (!live) {
    return {
      status: 'pass',
      detail: `必填参数：${required.join(', ')}（live 验证时用 --params 提供）`,
    };
  }

  return {
    status: 'skip',
    detail: `缺少必填参数 ${missing.join(', ')}（用 --params '{"${missing[0]}":"值"}' 提供）`,
  };
}

/** 返回非空字符串表示「不跑，原因是它」 */
function liveGate(verb: Verb, options: VerifyOptions): string | undefined {
  if (verb.risk === 'read') return undefined;
  if (!options.includeWrite) {
    return `${verb.risk} 级动词默认不跑（要跑加 --include-write）`;
  }
  if (verb.risk === 'destructive' && !options.confirmed) {
    return 'destructive 级动词需要 --include-write 且 --yes 双重确认';
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}

/* ── 汇总 ───────────────────────────────────────────────── */

export interface VerifySummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failedVerbs: string[];
}

export function summarize(reports: readonly VerifyReport[]): VerifySummary {
  const summary: VerifySummary = {
    total: reports.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    failedVerbs: [],
  };

  for (const report of reports) {
    if (report.status === 'pass') summary.passed++;
    else if (report.status === 'fail') {
      summary.failed++;
      summary.failedVerbs.push(report.verb);
    } else summary.skipped++;
  }

  return summary;
}
