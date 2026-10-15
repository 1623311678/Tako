/**
 * capture —— 把「真人点出来的网页操作」反推成能力声明。
 *
 * 为什么值得单独做一层：
 *   手写 tako.json 的门槛不在 JSON，而在「你得先知道那个系统背后调了什么接口」。
 *   而人其实早就知道怎么点 —— 所以最省事的路径是：让他点一遍，我们把请求抓下来，
 *   反推成 http 动词。生成结果仍需人补 aiExample，但它把「从零猜接口」变成了「改一改」。
 *
 * 反推规则（全部确定、可预测，不做花哨猜测）：
 *   · 连接：按请求的 origin 生成 arm（http），baseUrl 就是 origin
 *   · 名字：<首个路径段>.<末个有意义路径段>；撞名时补方法后缀
 *   · 路径参数：数字 / UUID / 长十六进制串 → 换成 :xxxId
 *   · 查询参数：query key 原样保留，类型按捕获值推断
 *   · 请求体：JSON 顶层字段逐个变成 body 参数（捕获到的值作为 example）
 *   · 风险：GET/HEAD=read，DELETE=destructive，其余=write
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadBrowserDriver } from './driver.js';
import { TakoError, loadManifest } from './manifest.js';
import type { CapturedRequest, HttpMethod, Manifest } from './types.js';

/** 原始捕获默认只留开始页面的同源请求，避免埋点噪声淹没有人想抓的接口 */
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
const CACHE_DIR = path.join('.tako', 'captures');

/** 只有这两类才是「接口调用」；文档 / 脚本 / 图片不是能力 */
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch']);

export interface CaptureOptions {
  manifestDir: string;
  startUrl?: string;
  durationMs?: number;
  /** 只保留 URL 含该子串的请求（可多次） */
  include?: readonly string[];
  exclude?: readonly string[];
  /** 允许跨源；默认只留开始页面同源 */
  allOrigins?: boolean;
  log: (line: string) => void;
}

export interface CaptureDiagnostics {
  /** 被过滤掉的请求及原因，写进报告让人知道漏了什么 */
  skipped: { url: string; reason: string }[];
}

export interface CaptureOutcome {
  /** 页面最终地址 */
  url: string;
  /** 原始捕获落盘位置（便于复盘与手工修正） */
  rawFile: string;
  requests: readonly CapturedRequest[];
  arm: DerivedArm;
  verbs: DerivedVerb[];
  diagnostics: CaptureDiagnostics;
}

export interface DerivedArm {
  name: string;
  adapter: 'http';
  baseUrl: string;
  description: string;
  auth: { type: 'none' | 'cookie' | 'bearer'; tokenEnv?: string };
}

/** 与清单里的 verb 同形状，可直接合并进 tako.json */
export interface DerivedVerb {
  name: string;
  arm: string;
  description: string;
  aiExample: string;
  risk: 'read' | 'write' | 'destructive';
  idempotent: boolean;
  action: { method: HttpMethod; path: string; headers?: Record<string, string> };
  params: DerivedParam[];
}

export interface DerivedParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  in: 'path' | 'query' | 'body';
  required: boolean;
  description: string;
  example?: unknown;
}

/* ── 录制 ───────────────────────────────────────────────── */

export async function capture(options: CaptureOptions): Promise<CaptureOutcome> {
  if (!options.startUrl) {
    throw new TakoError(
      '需要指定开始地址：tako capture --url <地址>\n' +
        '  · 想在浏览器里边操作边录：tako capture --url https://your-page --seconds 60\n' +
        '  · 只想看看会抓到什么：先加 --json',
      'USAGE',
    );
  }

  const driver = await loadBrowserDriver({
    manifestDir: options.manifestDir,
    rootDir: options.manifestDir,
    log: options.log,
  });

  if (typeof driver.capture !== 'function') {
    throw new TakoError(
      '当前 browser 驱动插件不支持 capture（tako capture 需要驱动实现 capture()）。\n' +
        '  官方驱动 @hun-dun/tako-adapter-browser 支持。',
      'DRIVER_INVALID',
    );
  }

  options.log(`开始录制：${options.startUrl}`);
  const result = await driver.capture({
    startUrl: options.startUrl,
    rootDir: options.manifestDir,
    durationMs: options.durationMs,
    log: options.log,
  });
  await driver.close?.();

  const rawFile = writeRawCapture(options.manifestDir, result.requests);
  const { kept, skipped } = filterRequests(result.requests, options);

  if (kept.length === 0) {
    throw new TakoError(
      `没有录到可用的接口请求（原始 ${result.requests.length} 条，全被过滤）。\n` +
        `  原始记录已落盘：${rawFile}\n` +
        '  · 页面可能没发起 XHR/fetch（静态渲染的页面没有接口可抓）\n' +
        '  · 或需要更长的录制时间：--seconds 60\n' +
        '  · 跨源接口要加 --all-origins',
      'USAGE',
      { rawFile },
    );
  }

  const origin = new URL(kept[0]?.url ?? options.startUrl).origin;
  const arm = deriveArm(origin, kept);
  const verbs = deriveVerbs(kept, arm.name);

  return { url: result.url, rawFile, requests: kept, arm, verbs, diagnostics: { skipped } };
}

function filterRequests(
  requests: readonly CapturedRequest[],
  options: CaptureOptions,
): { kept: CapturedRequest[]; skipped: { url: string; reason: string }[] } {
  const pageOrigin = options.startUrl ? safeOrigin(options.startUrl) : undefined;
  const kept: CapturedRequest[] = [];
  const skipped: { url: string; reason: string }[] = [];

  for (const request of requests) {
    const url = request.url;
    if (!/^https?:/i.test(url)) {
      skipped.push({ url, reason: '非 http(s)' });
      continue;
    }
    // 驱动报了资源类型时只留接口；没报则保留（兼容其他驱动）
    if (request.resourceType && !API_RESOURCE_TYPES.has(request.resourceType)) {
      skipped.push({ url, reason: `资源类型 ${request.resourceType}，不是接口` });
      continue;
    }
    if (options.include?.length && !options.include.some((needle) => url.includes(needle))) {
      skipped.push({ url, reason: '不匹配 --include' });
      continue;
    }
    if (options.exclude?.some((needle) => url.includes(needle))) {
      skipped.push({ url, reason: '命中 --exclude' });
      continue;
    }
    if (!options.allOrigins && pageOrigin && safeOrigin(url) !== pageOrigin) {
      skipped.push({ url, reason: '跨源（用 --all-origins 保留）' });
      continue;
    }
    kept.push(request);
  }

  return { kept, skipped };
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/* ── 反推 arm ───────────────────────────────────────────── */

function deriveArm(origin: string, requests: readonly CapturedRequest[]): DerivedArm {
  const host = new URL(origin).host;
  const name = sanitizeName(host.replace(/^www\./, '').replace(/\./g, '-')) || 'captured';

  // 抓到 Cookie 头说明接口靠会话鉴权，直接写进清单让使用方知道要带凭证
  const usesCookie = requests.some((request) =>
    Object.keys(request.headers).some((key) => key.toLowerCase() === 'cookie'),
  );

  return {
    name,
    adapter: 'http',
    baseUrl: origin,
    description: `capture 从 ${host} 录得`,
    auth: usesCookie ? { type: 'cookie', tokenEnv: 'TAKO_CAPTURED_COOKIE' } : { type: 'none' },
  };
}

/* ── 反推 verb ──────────────────────────────────────────── */

export function deriveVerbs(requests: readonly CapturedRequest[], armName: string): DerivedVerb[] {
  const used = new Set<string>();
  const verbs: DerivedVerb[] = [];

  for (const request of requests) {
    const derived = deriveVerb(request, armName);
    if (!derived) continue;

    if (used.has(derived.name)) {
      // 同名时用方法把它区分开，而不是加无意义的序号
      derived.name = `${derived.name}.${derived.action.method.toLowerCase()}`;
      if (used.has(derived.name)) continue;
    }
    used.add(derived.name);
    verbs.push(derived);
  }

  return verbs;
}

function deriveVerb(request: CapturedRequest, armName: string): DerivedVerb | undefined {
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return undefined;
  }

  const { path: actionPath, pathParams, hasId } = buildPath(parsed.pathname);
  const name = deriveName(parsed, hasId);
  if (!name) return undefined;

  const risk = riskOf(request.method);
  const params: DerivedParam[] = [...pathParams];

  for (const [key, value] of parsed.searchParams.entries()) {
    params.push({
      name: key,
      type: inferQueryType(value),
      in: 'query',
      required: false,
      description: '捕获自页面请求的查询参数',
      example: value,
    });
  }

  const bodyParams = deriveBodyParams(request);
  params.push(...bodyParams);

  const headers =
    bodyParams.length > 0 ? { 'Content-Type': 'application/json' } : undefined;

  return {
    name,
    arm: armName,
    description: `${request.method} ${parsed.pathname}${parsed.search} —— capture 录得`,
    aiExample: `当用户想${methodVerb(request.method)} ${parsed.pathname} 时调用。`,
    risk,
    idempotent: risk === 'read',
    action: {
      method: request.method,
      // 刻意不把捕获到的 query 串进 path：那会把某一次的取值固化成默认值，
      // 之后不传参就会静默发旧值。query 一律作为显式参数声明。
      path: actionPath,
      ...(headers ? { headers } : {}),
    },
    params,
  };
}
/** 把路径里的 ID 段换成 :xxxId，避免把某条记录的具体 ID 固化进清单 */
function buildPath(pathname: string): {
  path: string;
  pathParams: DerivedParam[];
  hasId: boolean;
} {
  const segments = pathname.split('/').filter(Boolean);
  const pathParams: DerivedParam[] = [];
  let hasId = false;
  const usedNames = new Set<string>();

  const mapped = segments.map((segment, index) => {
    if (!ID_SEGMENT.test(segment) || segment.startsWith(':')) return segment;

    hasId = true;
    const previous = segments[index - 1] ?? 'item';
    const base = `${previous.length > 0 && index > 0 ? singularize(previous) : 'id'}Id`;
    let name = sanitizeParam(base);
    if (usedNames.has(name)) name = `${name}${index}`;
    usedNames.add(name);

    pathParams.push({
      name,
      type: 'string',
      in: 'path',
      required: true,
      description: `捕获自路径的 ${previous} 标识`,
      example: segment,
    });
    return `:${name}`;
  });

  const path = `/${mapped.join('/')}`.replace(/([^:])\/{2,}/g, '$1/');
  return { path, pathParams, hasId };
}

function deriveName(parsed: URL, hasId: boolean): string | undefined {
  const segments = parsed.pathname.split('/').filter(Boolean);
  const meaningful = segments.filter((segment) => !ID_SEGMENT.test(segment));
  const first = meaningful[0];
  const last = meaningful[meaningful.length - 1];

  if (!first) {
    return sanitizeName(`root.${hasId ? 'detail' : 'index'}`);
  }
  if (meaningful.length === 1) {
    return sanitizeName(`${first}${hasId ? '.detail' : '.index'}`);
  }
  return sanitizeName(`${first}.${hasId ? `${last}-detail` : (last ?? 'index')}`);
}

function deriveBodyParams(request: CapturedRequest): DerivedParam[] {
  const body = request.body;
  if (body === undefined || body === null) return [];

  if (typeof body === 'string') {
    if (body.length === 0) return [];
    return [
      {
        name: 'body',
        type: 'string',
        in: 'body',
        required: true,
        description: '请求体（非 JSON）',
        example: body.slice(0, 200),
      },
    ];
  }

  if (typeof body !== 'object' || Array.isArray(body)) {
    return [
      {
        name: 'body',
        type: Array.isArray(body) ? 'array' : 'object',
        in: 'body',
        required: true,
        description: '请求体（数组 / 标量）',
        example: body,
      },
    ];
  }

  return Object.entries(body as Record<string, unknown>).map(([key, value]) => ({
    name: key,
    type: typeofOf(value),
    in: 'body' as const,
    required: true,
    description: '捕获自请求体的字段',
    example: value,
  }));
}

function riskOf(method: HttpMethod): DerivedVerb['risk'] {
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (method === 'DELETE') return 'destructive';
  return 'write';
}

function methodVerb(method: HttpMethod): string {
  switch (method) {
    case 'GET':
      return '查询接口';
    case 'POST':
      return '提交接口';
    case 'PUT':
    case 'PATCH':
      return '更新接口';
    case 'DELETE':
      return '删除接口';
    default:
      return '调用接口';
  }
}

/**
 * query 参数在 URL 里一律是字符串，但清单里写成数字/布尔更有用：
 * Agent 生成参数时不会替你套引号，类型写对了服务端能少一层转换。
 */
function inferQueryType(value: string): DerivedParam['type'] {
  if (/^-?\d+(\.\d+)?$/.test(value)) return 'number';
  if (value === 'true' || value === 'false') return 'boolean';
  return 'string';
}

function typeofOf(value: unknown): DerivedParam['type'] {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  return 'string';
}

/** 极轻量的单数化：够用就好，猜不出来就保持原样 */
function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/(ses|xes|zes|ches|shes)$/i.test(word)) return word.replace(/es$/i, '');
  if (/ss$/i.test(word)) return word;
  return word.replace(/s$/i, '');
}

/**
 * 参数名与动词名的规矩不同：动词名必须是全小写（清单 pattern 要求），
 * 但参数名该保留驼峰 —— path 里写 :taskId 比 :taskid 可读得多。
 */
function sanitizeParam(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_]+/g, '');
  if (!cleaned) return 'id';
  return /^[0-9]/.test(cleaned) ? `p${cleaned}` : cleaned;
}

/** 清单要求 name 匹配 ^[a-z0-9][a-z0-9._-]*$，这里保证生成物合法 */
function sanitizeName(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  return cleaned;
}

/* ── 落盘 ───────────────────────────────────────────────── */

/** 原始捕获永远留底：反推结果可能不合心意，但有原始记录就能手工修正 */
function writeRawCapture(manifestDir: string, requests: readonly CapturedRequest[]): string {
  const dir = path.join(manifestDir, CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}.json`);
  writeFileSync(file, `${JSON.stringify(requests, null, 2)}\n`, 'utf8');
  return file;
}

/* ── 合并进清单 ─────────────────────────────────────────── */

export interface CaptureMergeResult {
  manifestFile: string;
  addedArm?: string;
  addedVerbs: string[];
  skipped: string[];
}

/**
 * 把反推结果并入现有清单。
 * 冲突策略与 `tako add` 保持一致：同名默认跳过，--force 才覆盖。
 */
export function mergeCapture(options: {
  manifestFile: string;
  outcome: CaptureOutcome;
  force?: boolean;
}): CaptureMergeResult {
  const { manifestFile, outcome, force = false } = options;

  if (!existsSync(manifestFile)) {
    throw new TakoError(
      `当前目录没有 tako.json：${manifestFile}\n  先执行 \`tako init\`，或用 --out 只导出片段。`,
      'MANIFEST_NOT_FOUND',
    );
  }

  const raw = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
  const arms = Array.isArray(raw['arms']) ? (raw['arms'] as Record<string, unknown>[]) : [];
  const verbs = Array.isArray(raw['verbs']) ? (raw['verbs'] as Record<string, unknown>[]) : [];
  raw['arms'] = arms;
  raw['verbs'] = verbs;

  const result: CaptureMergeResult = { manifestFile, addedVerbs: [], skipped: [] };

  const existingArm = arms.find((arm) => arm['name'] === outcome.arm.name);
  if (!existingArm) {
    arms.push(outcome.arm as unknown as Record<string, unknown>);
    result.addedArm = outcome.arm.name;
  } else {
    result.skipped.push(`连接 ${outcome.arm.name}（已存在，保留原配置）`);
  }

  for (const verb of outcome.verbs) {
    const index = verbs.findIndex((item) => item['name'] === verb.name);
    if (index === -1) {
      verbs.push(verb as unknown as Record<string, unknown>);
      result.addedVerbs.push(verb.name);
      continue;
    }
    if (!force) {
      result.skipped.push(`动词 ${verb.name}（已存在，未覆盖）`);
      continue;
    }
    verbs[index] = verb as unknown as Record<string, unknown>;
    result.skipped.push(`动词 ${verb.name}（已覆盖）`);
  }

  writeFileSync(manifestFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return result;
}

/** 导出的片段形状：可直接粘进 tako.json */
export function toFragment(outcome: CaptureOutcome): { arms: unknown[]; verbs: unknown[] } {
  return { arms: [outcome.arm], verbs: outcome.verbs };
}

/** 合并后立刻用真实清单校验一遍，避免写出坏文件 */
export function assertManifestValid(manifestFile: string): Manifest {
  return loadManifest(manifestFile);
}
