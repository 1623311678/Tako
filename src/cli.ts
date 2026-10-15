#!/usr/bin/env node
/**
 * tako —— 让 AI 会操作。
 *
 * 命令面刻意保持极窄：ls / describe / run / tools / schema / doctor 管能力本身，
 * context / integrate 管「怎么把能力交给 Agent」。
 * 能力本身不写在这里，而是写在 tako.json 里 —— 这是 Tako 与普通 CLI 的根本差别：
 * CLI 是壳，清单才是本体。
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RISK_LEVELS,
  TakoError,
  loadManifest,
  requireVerb,
  toCliUsage,
  toFormSpec,
  toToolSpecs,
} from './manifest.js';
import { execute, usageFor } from './run.js';
import { bundledPacksRoot, addPack, listPacks } from './pack.js';
import { toAgentContext, toHookOutput } from './context.js';
import { integrate, listIntegrations, resolveIntegration, type IntegrateScope } from './integrate.js';
import { probeBrowserPlugin } from './driver.js';
import { askManifest } from './ask.js';
import { assertManifestValid, capture, mergeCapture, toFragment } from './capture.js';
import { summarize, verifyVerbs, type VerifyReport } from './verify.js';
import { buildPack, commitRepo, listRepo, looksLikeGit, resolveRepo } from './repo.js';
import { startConsole } from './console.js';
import type { Manifest, RiskLevel, TakoErrorCode } from './types.js';

const VERSION = readVersion();

/** 版本号只从 package.json 读，不在代码里再写一份 —— 两份就会漂移 */
function readVersion(): string {
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 这些 flag 属于 CLI 自身，不会透传给能力当参数 */
const RESERVED_FLAGS = new Set([
  'json',
  'dry-run',
  'yes',
  'y',
  'verbose',
  'file',
  'help',
  'h',
  'version',
  'arm',
  'risk',
]);

/* ── 终端样式 ───────────────────────────────────────────── */

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];
const paint =
  (code: string) =>
  (text: string | number): string =>
    COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text);

const dim = paint('2');
const bold = paint('1');
const cyan = paint('36');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');

const RISK_PAINT: Record<RiskLevel, (text: string | number) => string> = {
  read: green,
  write: yellow,
  destructive: red,
};

function riskBadge(risk: RiskLevel): string {
  return (RISK_PAINT[risk] ?? dim)(risk.padEnd(11));
}

/* ── 参数解析 ───────────────────────────────────────────── */

type FlagValue = string | boolean;

interface ParsedArgv {
  flags: Map<string, FlagValue>;
  positional: string[];
}

function parseArgv(argv: readonly string[]): ParsedArgv {
  const flags = new Map<string, FlagValue>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith('no-')) {
        flags.set(body.slice(3), false);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(body, next);
        i++;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      flags.set(token.slice(1), true);
      continue;
    }

    positional.push(token);
  }

  return { flags, positional };
}

const has = (flags: Map<string, FlagValue>, name: string): boolean => {
  const value = flags.get(name);
  return value === true || value === 'true';
};

const read = (flags: Map<string, FlagValue>, name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

/* ── 主流程 ─────────────────────────────────────────────── */

async function main(argv: readonly string[]): Promise<number> {
  const { flags, positional } = parseArgv(argv);
  const command = positional[0] ?? (has(flags, 'version') ? 'version' : 'help');

  if (has(flags, 'help') || has(flags, 'h')) return printHelp(positional[1]);
  if (has(flags, 'version') || command === 'version') {
    process.stdout.write(`tako ${VERSION}\n`);
    return 0;
  }

  switch (command) {
    case 'help':
      return printHelp(positional[1]);
    case 'init':
      return cmdInit(flags, positional[1]);
    case 'add':
      return await cmdAdd(flags, positional[1]);
    case 'ls':
      return cmdList(flags);
    case 'describe':
      return cmdDescribe(flags, positional[1]);
    case 'run':
      return await cmdRun(flags, positional.slice(1));
    case 'tools':
      return cmdTools(flags);
    case 'schema':
      return cmdSchema(flags);
    case 'doctor':
      return await cmdDoctor(flags);
    case 'context':
      return cmdContext(flags);
    case 'integrate':
      return cmdIntegrate(flags, positional[1]);
    case 'ask':
      return cmdAsk(flags, positional.slice(1).join(' '));
    case 'capture':
      return await cmdCapture(flags);
    case 'verify':
      return await cmdVerify(flags, positional.slice(1));
    case 'push':
      return await cmdPush(flags, positional.slice(1));
    case 'console':
      return await cmdConsole(flags);
    default:
      process.stderr.write(`${red('未知命令：')} ${command}\n\n`);
      printHelp();
      return 2;
  }
}

function load(flags: Map<string, FlagValue>): Manifest {
  return loadManifest(read(flags, 'file'));
}

/* ── ls ─────────────────────────────────────────────────── */

function cmdList(flags: Map<string, FlagValue>): number {
  const manifest = load(flags);
  const armFilter = read(flags, 'arm');
  const riskFilter = read(flags, 'risk');

  if (riskFilter && !RISK_LEVELS.includes(riskFilter as RiskLevel)) {
    throw new TakoError(`--risk 只能是 ${RISK_LEVELS.join(' / ')}`, 'USAGE');
  }

  const verbs = manifest.verbs.filter(
    (verb) =>
      (!armFilter || verb.arm === armFilter) && (!riskFilter || verb.risk === (riskFilter as RiskLevel)),
  );

  if (has(flags, 'json')) {
    printJson({
      project: manifest.project,
      manifest: manifest.file,
      count: verbs.length,
      verbs: verbs.map((verb) => ({
        name: verb.name,
        arm: verb.arm,
        risk: verb.risk,
        idempotent: verb.idempotent,
        description: verb.description,
        cli: toCliUsage(verb),
        params: verb.params.map((param) => ({
          name: param.name,
          type: param.type,
          required: param.required,
          in: param.in,
        })),
      })),
    });
    return 0;
  }

  process.stdout.write(
    `${bold(manifest.project)} ${dim(`· ${manifest.verbs.length} 个动词 · 清单 ${manifest.file}`)}\n\n`,
  );

  const rows = verbs.map((verb) => [
    cyan(verb.name),
    dim(verb.arm),
    riskBadge(verb.risk),
    verb.description,
  ]);
  process.stdout.write(`${renderTable(['VERB', 'ARM', 'RISK', 'DESCRIPTION'], rows)}\n`);

  if (verbs.length === 0) process.stdout.write(dim('  （没有匹配的动词）\n'));
  process.stdout.write(`\n${dim('下一步：')} tako describe <verb>  ·  tako run <verb> --dry-run\n`);
  return 0;
}

/* ── describe ───────────────────────────────────────────── */

function cmdDescribe(flags: Map<string, FlagValue>, name?: string): number {
  if (!name) throw new TakoError('用法：tako describe <verb> [--json]', 'USAGE');

  const manifest = load(flags);
  const verb = requireVerb(manifest, name);

  if (has(flags, 'json')) {
    printJson({
      verb,
      form: toFormSpec(verb),
      cli: toCliUsage(verb),
      tool: toToolSpecs({ ...manifest, verbs: [verb] })[0],
    });
    return 0;
  }

  process.stdout.write(`${bold(cyan(verb.name))}\n`);
  process.stdout.write(`${verb.description || dim('（无描述）')}\n\n`);
  process.stdout.write(
    `${dim('连接')}  ${verb.arm} ${dim(`(${manifest.armByName.get(verb.arm)?.adapter ?? '?'})`)}\n` +
      `${dim('风险')}  ${riskBadge(verb.risk)}\n` +
      `${dim('幂等')}  ${verb.idempotent ? '是' : '否'}\n` +
      `${dim('超时')}  ${verb.timeoutMs}ms\n`,
  );

  if (verb.aiExample) {
    process.stdout.write(`\n${dim('Agent 何时调用')}\n  ${verb.aiExample}\n`);
  }

  if (verb.params.length > 0) {
    process.stdout.write(`\n${dim('参数')}\n`);
    const rows = verb.params.map((param) => [
      param.required ? cyan(param.name) : param.name,
      param.type,
      dim(param.in),
      param.required
        ? red('必填')
        : param.default !== undefined
          ? `默认 ${JSON.stringify(param.default)}`
          : dim('可选'),
      param.enum ? dim(param.enum.join(' | ')) : param.description,
    ]);
    process.stdout.write(`${renderTable(['NAME', 'TYPE', 'IN', 'REQUIRED', 'DESCRIPTION'], rows)}\n`);
  }

  process.stdout.write(`\n${dim('命令行')}\n  ${toCliUsage(verb)}\n`);
  if (verb.risk === 'destructive') {
    process.stdout.write(`${dim('提示')}  危险操作，执行时需要显式加 ${bold('--yes')}\n`);
  }
  return 0;
}

/* ── run ────────────────────────────────────────────────── */

async function cmdRun(flags: Map<string, FlagValue>, rest: readonly string[]): Promise<number> {
  const [name, ...inlineArgs] = rest;
  if (!name) throw new TakoError('用法：tako run <verb> [--参数 值]', 'USAGE');
  if (inlineArgs.length > 0) {
    throw new TakoError(
      `多余的位置参数：${inlineArgs.join(' ')}\n  所有入参都请写成 --name value 的形式。\n  用法：${usageForPlaceholder(name)}`,
      'USAGE',
    );
  }

  const manifest = load(flags);
  const verb = requireVerb(manifest, name);

  const provided: Record<string, FlagValue> = {};
  for (const [key, value] of flags) {
    if (RESERVED_FLAGS.has(key)) continue;
    provided[key] = value;
  }

  const unknown = Object.keys(provided).filter((key) => !verb.params.some((param) => param.name === key));
  if (unknown.length > 0) {
    const known = verb.params.map((param) => param.name);
    throw new TakoError(
      `动词 ${name} 不认识这些参数：${unknown.join(', ')}\n` +
        `  它支持的参数：${known.length > 0 ? known.join(', ') : '（无）'}`,
      'PARAM_UNKNOWN',
    );
  }

  const dryRun = has(flags, 'dry-run');
  const confirmed = has(flags, 'yes') || has(flags, 'y');

  if (verb.risk === 'destructive' && !confirmed && !dryRun) {
    process.stderr.write(
      `${red('已拦截：')}${bold(verb.name)} 是 ${red('destructive')} 级操作，不可逆。\n` +
        `  确认影响范围后重跑：${bold(`tako run ${verb.name} ... --yes`)}\n` +
        `  只想看会发生什么：${bold(`tako run ${verb.name} ... --dry-run`)}\n`,
    );
    return 3;
  }

  const result = await execute(manifest, verb, provided, {
    dryRun,
    log: (line) => {
      if (has(flags, 'verbose')) process.stderr.write(`${dim(`· ${line}`)}\n`);
    },
  });

  if (has(flags, 'json')) {
    printJson(result);
    return 0;
  }

  if (dryRun) {
    process.stdout.write(`${yellow('dry-run')} ${dim('（未产生任何副作用）')}\n`);
    process.stdout.write(`${dim('计划')}\n`);
    printJson(result.plan);
    return 0;
  }

  process.stdout.write(
    `${green('✓')} ${bold(verb.name)} ${dim(`· ${result.durationMs ?? 0}ms`)}` +
      (result.status ? ` ${dim(`· HTTP ${result.status}`)}\n` : '\n'),
  );
  printPayload(result.data);
  return 0;
}

function usageForPlaceholder(name: string): string {
  return `tako run ${name} --参数 值`;
}

/* ── tools / schema / doctor ────────────────────────────── */

function cmdTools(flags: Map<string, FlagValue>): number {
  const manifest = load(flags);
  printJson({
    project: manifest.project,
    source: manifest.file,
    tools: toToolSpecs(manifest),
  });
  return 0;
}

function cmdSchema(flags: Map<string, FlagValue>): number {
  const schemaPath = fileURLToPath(new URL('../schema/tako.schema.json', import.meta.url));
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as unknown;

  if (has(flags, 'json')) {
    printJson(schema);
    return 0;
  }

  process.stdout.write(`${dim('清单校验规则')} ${schemaPath}\n`);
  process.stdout.write(
    `${dim('用法')} 在 tako.json 首行写 "$schema": "./schema/tako.schema.json"，编辑器即可补全与校验\n` +
      `       或在命令行执行 ${bold('tako doctor')} 做一次完整校验\n`,
  );
  return 0;
}

async function cmdDoctor(flags: Map<string, FlagValue>): Promise<number> {
  const manifest = load(flags);
  const lines: string[] = [];
  let warnings = 0;
  const browserArms: string[] = [];

  lines.push(`${green('✓')} 清单可解析：${manifest.file}`);
  lines.push(`${green('✓')} ${manifest.arms.length} 条连接 / ${manifest.verbs.length} 个动词`);

  for (const arm of manifest.arms) {
    const problems: string[] = [];

    if (arm.adapter === 'http') {
      if (!arm.baseUrl) problems.push('缺少 baseUrl');
      if (arm.auth.type !== 'none') {
        const envName = arm.auth.tokenEnv;
        if (!envName) problems.push('auth 未声明 tokenEnv');
        else if (!process.env[envName]) problems.push(`环境变量 ${envName} 未设置`);
      }
    }
    if (arm.adapter === 'script') {
      const hasScript = manifest.verbs.some((verb) => verb.arm === arm.name && verb.action.script);
      if (!hasScript) problems.push('script 类型的连接下没有任何 script 动词');
    }
    if (arm.adapter === 'browser') {
      browserArms.push(arm.name);
      const hasSteps = manifest.verbs.some(
        (verb) => verb.arm === arm.name && (verb.action.steps?.length || verb.action.flow),
      );
      if (!hasSteps) problems.push('browser 类型的连接下没有任何带 steps 的动词');
    }

    if (problems.length === 0) {
      lines.push(`  ${green('·')} ${arm.name} ${dim(`(${arm.adapter})`)} 就绪`);
      continue;
    }
    warnings += problems.length;
    lines.push(`  ${yellow('!')} ${arm.name} ${dim(`(${arm.adapter})`)} ${problems.join('；')}`);
  }

  for (const verb of manifest.verbs) {
    if (!verb.description) {
      lines.push(`  ${yellow('!')} ${verb.name} 缺少 description，Agent 无法判断何时调用`);
      warnings++;
    }
    if (!verb.aiExample) {
      lines.push(`  ${yellow('!')} ${verb.name} 缺少 aiExample，Agent 的自动路由会变弱`);
      warnings++;
    }
    if (verb.arm && manifest.armByName.get(verb.arm)?.adapter === 'browser' && !verb.action.steps?.length) {
      lines.push(`  ${red('×')} ${verb.name} 是 browser 动词但没有 action.steps，执行时必然失败`);
      warnings++;
    }
  }

  // browser 驱动是插件：单独探测一次，把「装没装、装在哪」说清楚
  if (browserArms.length > 0) {
    const report = await probeBrowserPlugin(manifest.dir);
    if (report.plugin) {
      lines.push(
        `  ${green('·')} browser 驱动就绪：${report.plugin.specifier} ${dim(`(${report.plugin.resolvedPath})`)}`,
      );
    } else {
      lines.push(
        `  ${yellow('!')} 未找到 browser 驱动插件（${browserArms.length} 条 browser 连接会执行失败）`,
      );
      for (const attempt of report.attempts) lines.push(`      ${dim(attempt)}`);
      lines.push(`      ${dim('装法：npm i -D @hun-dun/tako-adapter-browser，或在清单目录放 tako-browser.mjs')}`);
      warnings++;
    }
  }

  process.stdout.write(`${lines.join('\n')}\n\n`);
  process.stdout.write(
    warnings === 0
      ? `${green('全部就绪')}，可以直接 ${bold('tako run <verb>')}\n`
      : `${yellow(`${warnings} 处提醒`)}（不影响只读动词执行）\n`,
  );
  return 0;
}

/* ── context ────────────────────────────────────────────── */

/**
 * 把清单投影成「喂给 Agent 的一段话」。
 *
 * 挂成 hook 时用 --hook：无论发生什么都要输出一行可解析的 JSON ——
 * tako 自己的问题绝不能阻断用户的会话。
 */
function cmdContext(flags: Map<string, FlagValue>): number {
  const isHook = has(flags, 'hook');

  let manifest: Manifest | undefined;
  let context: string | undefined;

  try {
    manifest = load(flags);
    context = toAgentContext(manifest, { env: process.env });
  } catch (error) {
    if (!isHook) throw error;
    if (has(flags, 'verbose')) {
      process.stderr.write(
        `${yellow('·')} ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  if (isHook) {
    process.stdout.write(`${JSON.stringify(toHookOutput(context))}\n`);
    return 0;
  }

  if (has(flags, 'json')) {
    printJson({
      project: manifest?.project ?? '',
      source: manifest?.file ?? '',
      verbCount: manifest?.verbs.length ?? 0,
      verbs: (manifest?.verbs ?? []).map((verb) => ({
        name: verb.name,
        risk: verb.risk,
        aiExample: verb.aiExample,
      })),
      context: context ?? '',
    });
    return 0;
  }

  process.stdout.write(`${context ?? ''}\n`);
  return 0;
}

/* ── integrate ──────────────────────────────────────────── */

/** 把「让 AI 会用 tako」从手工配置变成一条命令 */
function cmdIntegrate(flags: Map<string, FlagValue>, targetId?: string): number {
  if (!targetId || has(flags, 'list')) {
    const rows = listIntegrations().map((item) => [
      cyan(item.id),
      dim(item.kind),
      item.title,
      item.description,
    ]);
    process.stdout.write(`${bold('可接入的 Agent')}\n\n`);
    process.stdout.write(`${renderTable(['TARGET', 'KIND', 'AGENT', 'NOTES'], rows)}\n`);
    if (!targetId) process.stdout.write(`\n${dim('接入其中一个：')} tako integrate <target>\n`);
    return 0;
  }

  const target = resolveIntegration(targetId);
  const scopeRaw = read(flags, 'scope') ?? 'project';
  if (scopeRaw !== 'project' && scopeRaw !== 'user') {
    throw new TakoError('--scope 只能是 project / user', 'USAGE');
  }
  const scope: IntegrateScope = scopeRaw;

  // 项目级配置落在清单所在目录；没有清单时退化为当前目录，并明确提示
  let rootDir = process.cwd();
  let hasManifest = true;
  try {
    rootDir = load(flags).dir;
  } catch {
    hasManifest = false;
  }

  const result = integrate({
    target,
    rootDir,
    scope,
    command: read(flags, 'command'),
    remove: has(flags, 'remove'),
    dryRun: has(flags, 'dry-run'),
  });

  const label: Record<typeof result.action, string> = {
    created: green('✓ 已接入'),
    updated: green('✓ 已更新'),
    removed: yellow('· 已移除'),
    unchanged: dim('· 无需改动'),
  };

  process.stdout.write(
    `${label[result.action]} ${bold(result.target.id)} ${dim(`(${result.target.title})`)}\n`,
  );
  process.stdout.write(`${dim('配置')} ${result.file}\n`);
  if (result.command) process.stdout.write(`${dim('命令')} ${result.command}\n`);
  for (const note of result.notes) process.stdout.write(`${dim('  ·')} ${note}\n`);

  if (!hasManifest) {
    process.stdout.write(`${yellow('!')} 当前目录没有 tako.json，配置落点按当前目录处理\n`);
  }
  if (result.action !== 'removed' && !has(flags, 'dry-run')) {
    process.stdout.write(`\n${dim('下一步：')} 重启 IDE / 新开会话后，Agent 会自动收到能力清单\n`);
  }
  return 0;
}

/* ── ask ────────────────────────────────────────────────── */

/** 低于这个分数就提示「仅供参考」，避免弱匹配被当真 */
const WEAK_MATCH_SCORE = 4;

/**
 * 用一句话找动词。
 *
 * 刻意只做本地关键词匹配：CLI 里引入 LLM 会破坏「运行时依赖为 0」，
 * 所以这里宁可弱一点，也要确定性、可解释。精确路由交给 Agent。
 */
function cmdAsk(flags: Map<string, FlagValue>, query?: string): number {
  if (!query) {
    throw new TakoError('用法：tako ask "你想做什么" [--top 3] [--json]', 'USAGE');
  }

  const manifest = load(flags);
  const topRaw = read(flags, 'top');
  const top = topRaw === undefined ? 3 : Number(topRaw);
  if (!Number.isInteger(top) || top < 1) {
    throw new TakoError('--top 需要是正整数', 'USAGE');
  }

  const hits = askManifest(manifest, query, { top });

  if (has(flags, 'json')) {
    printJson({
      query,
      source: manifest.file,
      hits: hits.map((hit) => ({
        verb: hit.verb.name,
        risk: hit.verb.risk,
        score: hit.score,
        matched: hit.matched,
        aiExample: hit.verb.aiExample,
        command: hit.command,
      })),
    });
    return 0;
  }

  process.stdout.write(`${bold('问：')} ${query}\n`);

  if (hits.length === 0) {
    process.stdout.write(
      `${yellow('没有找到相关动词')}\n` +
        `  · 看看有哪些：${bold('tako ls')}\n` +
        `  · 装能力包：  ${bold('tako add --list')}\n` +
        `  · 加新能力：  往 tako.json 的 verbs 里加一条\n`,
    );
    return 0;
  }

  process.stdout.write(
    `${dim('本地关键词匹配，不是语义理解；要精确路由请让 Agent 读 tako context')}\n\n`,
  );
  const rows = hits.map((hit) => [
    cyan(hit.verb.name),
    riskBadge(hit.verb.risk),
    String(hit.score),
    hit.verb.aiExample || hit.verb.description,
  ]);
  process.stdout.write(`${renderTable(['VERB', 'RISK', 'SCORE', 'WHY'], rows)}\n`);

  const best = hits[0];
  if (best && best.score < WEAK_MATCH_SCORE) {
    process.stdout.write(
      `\n${yellow('!')} 匹配较弱（最高 ${best.score} 分）：仅供参考。\n` +
        `  想让路由更准：在 tako.json 里给相关动词补 aiExample，或直接 tako ls 看全部\n`,
    );
  }

  process.stdout.write(`\n${dim('执行：')} ${best?.command ?? ''}\n`);
  return 0;
}

/* ── capture ────────────────────────────────────────────── */

/**
 * 把「真人点出来的操作」录成能力声明。
 *
 * 刻意的分工：capture 只负责「看→反推」，不假装能理解业务。
 * 生成的 aiExample 是一句占位语，让人去改成真正的「何时调用」——
 * 那句话只能人来写，写好了 Agent 路由才准。
 */
async function cmdCapture(flags: Map<string, FlagValue>): Promise<number> {
  const url = read(flags, 'url');
  let manifestDir = process.cwd();
  let hasManifest = true;
  try {
    manifestDir = load(flags).dir;
  } catch {
    hasManifest = false;
  }

  const secondsRaw = read(flags, 'seconds');
  const seconds = secondsRaw === undefined ? 30 : Number(secondsRaw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new TakoError('--seconds 需要是正数（秒）', 'USAGE');
  }

  const outcome = await capture({
    manifestDir,
    startUrl: url,
    durationMs: Math.round(seconds * 1000),
    include: splitList(read(flags, 'include')),
    exclude: splitList(read(flags, 'exclude')),
    allOrigins: has(flags, 'all-origins'),
    log: (line) => {
      if (has(flags, 'verbose')) process.stderr.write(`${dim(`· ${line}`)}\n`);
    },
  });

  if (has(flags, 'json')) {
    printJson({
      url: outcome.url,
      rawFile: outcome.rawFile,
      arm: outcome.arm,
      verbs: outcome.verbs,
      captured: outcome.requests.length,
      skipped: outcome.diagnostics.skipped,
    });
    return 0;
  }

  process.stdout.write(
    `${green('✓')} 录到 ${bold(outcome.requests.length)} 条接口请求 ${dim(`（跳过 ${outcome.diagnostics.skipped.length} 条）`)}\n`,
  );
  process.stdout.write(
    `${dim('连接')} ${outcome.arm.name} ${dim(`(http · ${outcome.arm.baseUrl})`)}\n`,
  );
  process.stdout.write(`${dim('原始记录')} ${outcome.rawFile}\n\n`);

  const rows = outcome.verbs.map((verb) => [
    cyan(verb.name),
    riskBadge(verb.risk),
    verb.action.method,
    verb.params.length > 0 ? dim(`${verb.params.length} 个参数`) : dim('无参数'),
  ]);
  process.stdout.write(`${bold('反推出 ' + outcome.verbs.length + ' 个动词')}\n`);
  process.stdout.write(`${renderTable(['VERB', 'RISK', 'METHOD', 'PARAMS'], rows)}\n`);

  const out = read(flags, 'out');
  if (out) {
    const file = path.resolve(out);
    writeFileSync(file, `${JSON.stringify(toFragment(outcome), null, 2)}\n`, 'utf8');
    process.stdout.write(`\n${green('✓')} 片段已导出 ${file}\n`);
  }

  if (has(flags, 'write')) {
    if (!hasManifest) {
      throw new TakoError(
        '当前目录没有 tako.json，无法 --write。\n  先 tako init，或用 --out 只导出片段。',
        'MANIFEST_NOT_FOUND',
      );
    }
    const manifestFile = path.join(manifestDir, 'tako.json');
    const merged = mergeCapture({
      manifestFile,
      outcome,
      force: has(flags, 'force'),
    });

    // 写完立刻回读校验，绝不留下一个坏清单
    const manifest = assertManifestValid(manifestFile);

    process.stdout.write(`\n${green('✓')} 已写入 ${manifestFile}\n`);
    if (merged.addedArm) process.stdout.write(`${dim('新增连接')} ${merged.addedArm}\n`);
    if (merged.addedVerbs.length > 0) {
      process.stdout.write(`${dim('新增动词')} ${merged.addedVerbs.join(', ')}\n`);
    }
    for (const note of merged.skipped) process.stdout.write(`${yellow('·')} ${dim(note)}\n`);
    process.stdout.write(`${dim('清单现在共')} ${manifest.verbs.length} ${dim('个动词')}\n`);
  }

  process.stdout.write(
    `\n${yellow('必做')} 给新动词补 ${bold('aiExample')} —— 它决定 Agent 何时该调用这条能力。\n` +
      `      capture 只能反推出「调什么」，那句话得人来写。\n` +
      `${dim('下一步：')} 改完跑 ${bold('tako doctor')} 体检，再 ${bold('tako run <verb> --dry-run')} 看请求计划\n`,
  );
  return 0;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/* ── verify ─────────────────────────────────────────────── */

/**
 * 验证清单里的能力。默认只做静态体检（零副作用），--live 才真调用。
 */
async function cmdVerify(flags: Map<string, FlagValue>, names: readonly string[]): Promise<number> {
  const manifest = load(flags);
  const verbs = names.length > 0 ? names.map((name) => requireVerb(manifest, name)) : manifest.verbs;

  const reports = await verifyVerbs(manifest, verbs, {
    live: has(flags, 'live'),
    includeWrite: has(flags, 'include-write'),
    confirmed: has(flags, 'yes') || has(flags, 'y'),
    params: parseParams(read(flags, 'params')),
  });

  const summary = summarize(reports);

  if (has(flags, 'json')) {
    printJson({ source: manifest.file, summary, reports });
    return summary.failed > 0 ? 1 : 0;
  }

  const mode = has(flags, 'live') ? 'live' : 'static';
  process.stdout.write(
    `${bold(manifest.project)} ${dim(`· ${reports.length} 个动词 · ${mode} 验证`)}${dim(` · ${manifest.file}`)}\n\n`,
  );

  const rows = reports.map((report) => [
    cyan(report.verb),
    riskBadge(report.risk),
    statusBadge(report.status),
    truncateText(primaryDetail(report), 72),
  ]);
  process.stdout.write(`${renderTable(['VERB', 'RISK', 'STATUS', 'DETAIL'], rows)}\n\n`);

  // 失败与跳过的具体原因单独展开，表格里放不下
  for (const report of reports) {
    if (report.status === 'pass') continue;
    process.stdout.write(`${statusBadge(report.status)} ${bold(report.verb)}\n`);
    for (const check of report.checks) {
      if (check.status === 'pass') continue;
      process.stdout.write(`  ${mark(check.status)} ${dim(check.name)} ${check.detail}\n`);
    }
    if (report.error && report.error.includes('\n')) {
      for (const line of report.error.split('\n').slice(1, 6)) {
        process.stdout.write(`    ${dim(line)}\n`);
      }
    }
    process.stdout.write('\n');
  }

  const tone = summary.failed > 0 ? red : summary.skipped > 0 ? yellow : green;
  process.stdout.write(
    `${tone('结果')} 通过 ${summary.passed} · 失败 ${summary.failed} · 跳过 ${summary.skipped}\n`,
  );

  if (!has(flags, 'live') && manifest.verbs.some((verb) => verb.risk === 'read')) {
    process.stdout.write(
      `${dim('提示：')} 这轮没真调用。想端到端跑一遍：${bold('tako verify --live')}` +
        `${dim('（write 级还需 --include-write）')}\n`,
    );
  }

  if (summary.failed > 0) {
    process.stdout.write(`\n${red('失败')} ${summary.failedVerbs.join(', ')}\n`);
  }
  return summary.failed > 0 ? 1 : 0;
}

function parseParams(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TakoError(
      `--params 需要是 JSON 对象，例如 --params '{"env":"test"}'\n  收到：${raw}`,
      'USAGE',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TakoError('--params 需要是 JSON 对象（不是数组或标量）', 'USAGE');
  }
  return parsed as Record<string, unknown>;
}

function statusBadge(status: VerifyReport['status']): string {
  if (status === 'pass') return green('pass'.padEnd(6));
  if (status === 'fail') return red('FAIL'.padEnd(6));
  return yellow('skip'.padEnd(6));
}

function mark(status: VerifyReport['status']): string {
  return status === 'fail' ? red('×') : yellow('!');
}

/** 表格里那一列：pass 只看通过项，失败/跳过才展示原因 */
function primaryDetail(report: VerifyReport): string {
  if (report.status !== 'pass') {
    const notable = report.checks.find((check) => check.status !== 'pass');
    if (notable) return notable.detail;
  }
  const last = report.checks[report.checks.length - 1];
  if (!last) return '';
  return report.status === 'pass' && last.name === '参数' ? last.detail : `${last.name}: ${last.detail}`;
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/* ── push ───────────────────────────────────────────────── */

/**
 * 把能力发布到能力仓库。仓库用 git，而不是自建服务 ——
 * 版本、review、权限、历史，git 都已经有了（详见 src/repo.ts 的说明）。
 */
async function cmdPush(flags: Map<string, FlagValue>, names: readonly string[]): Promise<number> {
  const to = read(flags, 'to');
  if (!to) {
    throw new TakoError(
      '需要指定能力仓库：\n' +
        '  tako push --to ./capability-repo\n' +
        '  tako push --to git@host:team/capability-repo.git\n' +
        '  先看看仓库里有什么：tako push --to <仓库> --list',
      'USAGE',
    );
  }

  const log = (line: string) => {
    if (has(flags, 'verbose')) process.stderr.write(`${dim(`· ${line}`)}\n`);
  };
  const repo = await resolveRepo(to, log);

  if (has(flags, 'list')) {
    const listing = listRepo(repo.dir);
    if (has(flags, 'json')) {
      printJson(listing);
      return 0;
    }
    process.stdout.write(
      `${bold('能力仓库')} ${dim(repo.dir)}${repo.kind === 'git' ? dim(` ← ${repo.source}`) : ''}\n\n`,
    );
    if (listing.packs.length === 0) {
      process.stdout.write(`${dim('  （还没有发布过能力包）')}\n`);
      return 0;
    }
    const rows = listing.packs.map((pack) => [
      cyan(pack.name),
      pack.version,
      String(pack.verbs.length),
      pack.review.status === 'approved' ? green('approved') : yellow('pending'),
      pack.review.reviewer ?? dim('-'),
      dim(pack.digest),
    ]);
    process.stdout.write(
      `${renderTable(['PACK', 'VERSION', 'VERBS', 'REVIEW', 'REVIEWER', 'DIGEST'], rows)}\n`,
    );
    return 0;
  }

  const manifest = load(flags);
  const dryRun = has(flags, 'dry-run');

  const result = buildPack({
    manifestFile: manifest.file,
    repo,
    verbNames: names,
    packName: read(flags, 'pack'),
    version: read(flags, 'version'),
    description: read(flags, 'description'),
    publisher: read(flags, 'publisher'),
    approve: has(flags, 'approve'),
    reviewer: read(flags, 'reviewer'),
    dryRun,
    log,
  });

  const commit = dryRun
    ? { committed: false, pushed: false, note: undefined as string | undefined }
    : await commitRepo(
        repo,
        `tako push: ${result.pack.name}@${result.pack.version}（${result.pack.verbs.length} 个动词）`,
        log,
      );

  if (has(flags, 'json')) {
    printJson({ repo: { dir: repo.dir, kind: repo.kind, source: repo.source }, ...result, commit });
    return 0;
  }

  process.stdout.write(
    `${dryRun ? yellow('dry-run') : green('✓')} ${bold(result.pack.name)}@${result.pack.version} ` +
      `${dim(`· ${result.pack.verbs.length} 个动词`)}${dryRun ? dim('（未写盘）') : ''}\n`,
  );
  process.stdout.write(`${dim('仓库')} ${repo.dir}${repo.kind === 'git' ? dim(` ← ${repo.source}`) : ''}\n`);
  process.stdout.write(`${dim('内容')} ${result.pack.verbs.join(', ')}\n`);
  process.stdout.write(`${dim('连接')} ${result.pack.arms.join(', ') || '（无）'}\n`);
  process.stdout.write(
    `${dim('摘要')} ${result.pack.digest}` +
      (result.changed ? yellow('  ← 内容有变化') : dim('  （与上一版一致）')) +
      '\n',
  );
  process.stdout.write(
    `${dim('审核')} ` +
      (result.pack.review.status === 'approved'
        ? green(`approved by ${result.pack.review.reviewer ?? '?'}`)
        : `${yellow('pending')} ${dim('（审查后加 --approve --reviewer <人> 标记通过）')}`) +
      '\n',
  );
  if (result.scripts.length > 0) {
    process.stdout.write(`${dim('脚本')} ${result.scripts.join(', ')}\n`);
  }
  if (commit.committed) {
    process.stdout.write(`${dim('提交')} ${commit.pushed ? green('已提交并推送') : yellow('已提交（未推送）')}\n`);
  }
  if (commit.note) process.stdout.write(`${dim('  ·')} ${commit.note}\n`);

  process.stdout.write(
    `\n${dim('别人装上它：')} ${bold(`tako add ${result.pack.name} --from ${repo.source}`)}\n`,
  );
  return 0;
}

/* ── console ────────────────────────────────────────────── */

/**
 * 本地控制台：起一个零依赖的本地服务，提供三视图页面。
 * 页面数据全部来自公共 API，和 CLI 用同一组函数 —— 不是又实现一遍。
 */
async function cmdConsole(flags: Map<string, FlagValue>): Promise<number> {
  const manifest = load(flags);

  const portRaw = read(flags, 'port');
  const port = portRaw === undefined ? undefined : Number(portRaw);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new TakoError('--port 需要是 1-65535 的整数', 'USAGE');
  }

  const handle = await startConsole({
    manifestFile: manifest.file,
    port,
    host: read(flags, 'host'),
    log: () => {},
  });

  if (has(flags, 'json')) {
    printJson({ url: handle.url, port: handle.port, manifest: manifest.file });
  } else {
    process.stdout.write(
      `${green('✓')} 控制台已启动 ${bold(handle.url)}\n` +
        `${dim('清单')} ${manifest.file} ${dim(`· ${manifest.verbs.length} 个动词`)}\n` +
        `${dim('说明')} 只绑定本机回环地址；Ctrl+C 停止\n`,
    );
  }

  if (has(flags, 'open')) openBrowser(handle.url);

  // 一直服务到被中断：控制台是「开着用」的东西
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void handle.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // 打不开就算了：URL 已经打印出来
  }
}

/* ── init ───────────────────────────────────────────────── */

/** 生成 tako.json 骨架：这是「别人从零接入」的第一步 */
function cmdInit(flags: Map<string, FlagValue>, dirArg?: string): number {
  const target = dirArg ? path.resolve(dirArg) : process.cwd();
  const projectName = sanitizeProjectName(path.basename(target) || 'tako-project');
  const manifestPath = path.join(target, 'tako.json');

  if (existsSync(manifestPath) && !has(flags, 'force')) {
    process.stderr.write(`${yellow('已存在')} ${manifestPath}\n  换个目录，或加 ${bold('--force')} 覆盖。\n`);
    return 2;
  }

  mkdirSync(target, { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(initTemplate(projectName), null, 2)}\n`, 'utf8');
  // 只在没有 .gitignore 时创建：覆盖别人已有的忽略规则是不可接受的副作用
  const gitignorePath = path.join(target, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, 'node_modules/\n.env\n.tako/\n', 'utf8');
  }

  process.stdout.write(
    `${green('✓')} 已创建 ${bold(projectName)}：${manifestPath}\n\n` +
      `${dim('接下来四步')}\n` +
      `  1. 编辑 tako.json：把 baseUrl 换成你的平台地址\n` +
      `  2. ${dim('export')} MY_PLATFORM_TOKEN=<令牌>   （令牌只从环境变量读，不会写进清单）\n` +
      `  3. ${bold('tako doctor')}                    体检清单与认证\n` +
      `  4. ${bold('tako run ping --dry-run')}        先预览请求，再正式执行\n\n` +
      `${dim('给 AI 用')}  tako tools --json\n` +
      `${dim('编辑器补全')} 把 "$schema" 指向 npm 包内的 schema/tako.schema.json（tako schema 可查看路径）\n`,
  );
  return 0;
}

function sanitizeProjectName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'tako-project';
}

function initTemplate(project: string): object {
  return {
    tako: 1,
    project,
    description:
      '把系统动作变成 AI 可调用的能力：先改 baseUrl 与 tokenEnv，再逐步添加 verbs。' +
      '列出的动词都只读，可以先跑通链路。',
    arms: [
      {
        name: 'platform',
        adapter: 'http',
        baseUrl: 'https://api.example.com',
        description: '你的平台。令牌只从环境变量读取，永不写进清单。',
        auth: { type: 'bearer', tokenEnv: 'MY_PLATFORM_TOKEN' },
      },
    ],
    verbs: [
      {
        name: 'ping',
        arm: 'platform',
        description: '确认平台可达，最适合用来验证接入没问题',
        risk: 'read',
        idempotent: true,
        aiExample: '当用户问「平台还通吗」时调用。',
        action: { method: 'GET', path: '/health' },
        params: [],
      },
      {
        name: 'item.get',
        arm: 'platform',
        description: '按 ID 查询一条记录',
        risk: 'read',
        idempotent: true,
        aiExample: '当用户给出一个 ID 想查对应记录时调用。',
        action: { method: 'GET', path: '/items/:id' },
        params: [
          {
            name: 'id',
            in: 'path',
            type: 'string',
            required: true,
            description: '记录 ID',
          },
        ],
      },
      {
        name: 'item.update',
        arm: 'platform',
        description: '更新一条记录的备注（示例：演示 write 级与 body 参数）',
        risk: 'write',
        aiExample: '当用户想改某条记录的备注时调用，修改前先确认新内容。',
        action: { method: 'PATCH', path: '/items/:id', headers: { 'Content-Type': 'application/json' } },
        params: [
          { name: 'id', in: 'path', type: 'string', required: true, description: '记录 ID' },
          { name: 'note', in: 'body', type: 'string', required: true, description: '新的备注内容' },
        ],
      },
    ],
  };
}

/* ── add ─────────────────────────────────────────────────── */

/** 装上能力包：把纯数据的声明与自包含脚本合并进当前项目，核心零改动 */
async function cmdAdd(flags: Map<string, FlagValue>, packName?: string): Promise<number> {
  let from = read(flags, 'from');

  // 仓库来源可以是 git 地址：先拉到本地缓存，再当成目录用
  if (from && looksLikeGit(from)) {
    const repo = await resolveRepo(from, (line) => {
      if (has(flags, 'verbose')) process.stderr.write(`${dim(`· ${line}`)}\n`);
    });
    from = repo.dir;
  }

  if (!packName || has(flags, 'list')) {
    const packs = listPacks(from);
    if (packs.length === 0) {
      process.stdout.write(`${yellow('没有找到能力包')}\n`);
      return 0;
    }
    process.stdout.write(
      `${bold('可用能力包')} ${dim(from ? path.resolve(from) : bundledPacksRoot())}\n\n`,
    );
    const rows = packs.map((pack) => [
      cyan(pack.name),
      String(pack.verbs.length),
      pack.description,
    ]);
    process.stdout.write(`${renderTable(['PACK', 'VERBS', 'DESCRIPTION'], rows)}\n`);
    if (!packName) {
      process.stdout.write(`\n${dim('装上其中一个：')} tako add <pack>\n`);
      return 0;
    }
    return 0;
  }

  const manifestFile = path.join(process.cwd(), 'tako.json');
  const result = addPack({ manifestFile, packName, from, force: has(flags, 'force') });

  process.stdout.write(`${green('✓')} 已装上能力包 ${bold(result.pack.name)}\n`);
  process.stdout.write(`${dim('清单')} ${result.manifestFile}\n\n`);

  if (result.addedArms.length > 0) {
    process.stdout.write(`${dim('新增连接')}  ${result.addedArms.join(', ')}\n`);
  }
  if (result.addedVerbs.length > 0) {
    process.stdout.write(`${dim('新增动词')} ${result.addedVerbs.join(', ')}\n`);
  }
  if (result.installedScripts.length > 0) {
    process.stdout.write(`${dim('脚本已拷贝')} ${result.installedScripts.join(', ')}\n`);
  }
  for (const note of result.skipped) {
    process.stdout.write(`${yellow('·')} ${dim(note)}\n`);
  }

  // 把新装能力需要的环境变量直接告诉用户，而不是让他自己找
  const manifest = loadManifest(manifestFile);
  const envHints = manifest.arms
    .filter((arm) => result.addedArms.includes(arm.name) && arm.auth.type !== 'none')
    .map((arm) => arm.auth.tokenEnv)
    .filter((name): name is string => Boolean(name));

  if (envHints.length > 0) {
    process.stdout.write(`\n${yellow('需要设置环境变量')}\n`);
    for (const name of envHints) {
      process.stdout.write(`  export ${bold(name)}=<令牌>   ${dim(process.env[name] ? '（已设置）' : '')}\n`);
    }
  }

  process.stdout.write(
    `\n${dim('下一步：')} tako doctor   ${dim('→')}   tako ls   ${dim('→')}   tako describe <verb>\n`,
  );
  return 0;
}

/* ── 输出工具 ───────────────────────────────────────────── */

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printPayload(data: unknown): void {
  if (data === undefined || data === null) {
    process.stdout.write(`${dim('（无返回内容）')}\n`);
    return;
  }
  if (typeof data === 'string') {
    process.stdout.write(`${data}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const all = [header, ...rows];
  const widths = header.map((_, column) =>
    Math.max(...all.map((row) => stripAnsi(row[column] ?? '').length)),
  );

  return all
    .map((row) =>
      row
        .map((cell, column) => {
          const text = cell ?? '';
          const pad = ' '.repeat(Math.max(0, (widths[column] ?? 0) - stripAnsi(text).length));
          return text + pad;
        })
        .join('  ')
        .replace(/\s+$/, ''),
    )
    .join('\n');
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/* ── 帮助 ───────────────────────────────────────────────── */

function printHelp(command?: string): number {
  if (command && command !== 'help') {
    process.stdout.write(`${bold(`tako ${command}`)} ${dim('— 见下方通用用法')}\n\n`);
  }
  process.stdout.write(
    `${bold('tako')} ${dim('· 让 AI 会操作')}\n\n` +
      `${dim('用法')}  tako <command> [options]\n\n` +
      `${bold('命令')}\n` +
      `  ${cyan('init')}       生成一份 tako.json 骨架\n` +
      `  ${cyan('add')}        装上能力包（tako add --list 查看内置包）\n` +
      `  ${cyan('ls')}         列出清单里的所有动词\n` +
      `  ${cyan('describe')}   查看单个动词的参数、风险与用法\n` +
      `  ${cyan('run')}        执行一个动词\n` +
      `  ${cyan('tools')}      输出 AI Agent 可注册的工具定义（JSON）\n` +
      `  ${cyan('schema')}     输出清单的 JSON Schema\n` +
      `  ${cyan('doctor')}     体检清单、连接与环境变量\n` +
      `  ${cyan('context')}    输出给 AI Agent 的能力清单上下文（--hook 供 hook 调用）\n` +
      `  ${cyan('integrate')}  把能力清单接进 Agent（tako integrate --list 查看目标）\n` +
      `  ${cyan('ask')}        用一句话找动词（本地匹配，best-effort）\n` +
      `  ${cyan('capture')}    录制网页操作，反推出 http 动词（需 browser 驱动插件）\n` +
      `  ${cyan('verify')}     验证清单里的能力（默认零副作用，--live 真调用）\n` +
      `  ${cyan('push')}       把能力发布到能力仓库（--to 目录或 git 地址）\n` +
      `  ${cyan('console')}    本地控制台（零依赖，打开即用）\n\n` +
      `${bold('常用选项')}\n` +
      `  --file <path>   指定清单路径（默认向上查找 tako.json）\n` +
      `  --from <dir>    能力包来源目录（配合 tako add）\n` +
      `  --scope <s>     配置落点 project / user（配合 tako integrate）\n` +
      `  --hook          hook 模式：始终输出可解析 JSON，绝不阻断会话\n` +
      `  --force         覆盖已存在的清单项或脚本\n` +
      `  --json          机器可读输出\n` +
      `  --dry-run       只预览请求计划，不产生副作用\n` +
      `  --yes           确认执行 destructive 级动词\n` +
      `  --verbose       打印执行细节\n\n` +
      `${bold('例子')}\n` +
      `  tako context                    看 Agent 会收到什么\n` +
      `  tako ask "最近提交都有啥"       一句话找动词\n` +
      `  tako capture --url https://x/ --write   录一遍网页操作→写入清单\n` +
      `  tako verify --live                       端到端验证只读能力\n` +
      `  tako push --to ./repo --approve          发布能力并标记审核通过\n` +
      `  tako console --open                      打开本地控制台\n` +
      `  tako integrate claude-code      把清单接进 Claude Code / CodeFlicker\n` +
      `  tako add dev                    装上研发能力包\n` +
      `  tako ls --risk destructive\n` +
      `  tako describe echo\n` +
      `  tako run echo --message hello --json\n` +
      `  tako run purge-cache --scope stale --dry-run\n\n` +
      `${bold('环境变量')}\n` +
      `  TAKO_MANIFEST   清单路径\n` +
      `  TAKO_SECRET_*   以 secret 声明的参数取值\n` +
      `  <arm.auth.tokenEnv>  各条连接的令牌，由清单声明、运行时注入\n`,
  );
  return 0;
}

/* ── 入口 ───────────────────────────────────────────────── */

/** 这些错误码属于「用错了」或「清单写错了」，统一返回 2，与运行期失败区分开 */
const USAGE_CODES = new Set<TakoErrorCode>([
  'USAGE',
  'MANIFEST_NOT_FOUND',
  'MANIFEST_INVALID',
  'MANIFEST_INVALID_JSON',
  'VERB_NOT_FOUND',
  'PARAM_UNKNOWN',
  'PARAM_MISSING',
  'PARAM_TYPE',
]);

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof TakoError) {
      process.stderr.write(`${red(`✗ ${error.code}`)}\n${error.message}\n`);
      process.exitCode = USAGE_CODES.has(error.code) ? 2 : 1;
      return;
    }
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${red('✗ 未处理的错误')}\n${detail}\n`);
    process.exitCode = 1;
  });
