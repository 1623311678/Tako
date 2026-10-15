/**
 * 运行时：把「动词 + 参数」真正执行掉。
 *
 * 设计要点：
 *   · 认证全托管 —— 适配器统一注入凭证，能力定义里永远不碰登录
 *   · 先 plan 再 invoke —— plan 供 --dry-run 预览，invoke 才产生副作用
 *   · 输出归一化 —— 无论适配器是什么，调用方拿到的结构一致
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TakoError } from './manifest.js';
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
  Arm,
  BrowserPlan,
  ExecutionOptions,
  ExecutionResult,
  HttpMethod,
  HttpPlan,
  InvokeContext,
  Manifest,
  ParameterValues,
  ScriptContext,
  ScriptEntry,
  ScriptPlan,
  Verb,
} from './types.js';

/* ── 入口 ───────────────────────────────────────────────── */

export async function execute(
  manifest: Manifest,
  verb: Verb,
  provided: ParameterValues,
  options: ExecutionOptions = {},
): Promise<ExecutionResult> {
  const arm = manifest.armByName.get(verb.arm);
  if (!arm) {
    throw new TakoError(`动词 ${verb.name} 引用的 arm "${verb.arm}" 不存在。`, 'ARM_INVALID');
  }

  const adapter = adapterFor(arm.adapter);
  if (!adapter) {
    throw new TakoError(`适配器 "${arm.adapter}" 尚未注册。`, 'ADAPTER_UNKNOWN');
  }

  const { values, missing } = resolveParams(verb, provided);
  if (missing.length > 0) {
    throw new TakoError(
      `缺少必填参数：${missing.join(', ')}\n  用法：${usageFor(verb)}`,
      'PARAM_MISSING',
    );
  }

  const log = options.log ?? (() => {});
  const context: InvokeContext = { manifest, arm, verb, values, log };
  const plan = await adapter.plan(context);

  if (options.dryRun) {
    return { ok: true, dryRun: true, verb: verb.name, arm: arm.name, plan };
  }

  const startedAt = Date.now();
  const result = await adapter.invoke(context);

  return {
    ok: true,
    dryRun: false,
    verb: verb.name,
    arm: arm.name,
    risk: verb.risk,
    durationMs: Date.now() - startedAt,
    plan,
    status: result.status,
    headers: result.headers,
    data: result.data,
  };
}

export function usageFor(verb: Verb): string {
  const flags = verb.params.map((param) =>
    param.required ? `--${param.name} <${param.type}>` : `[--${param.name} <${param.type}>]`,
  );
  return [`tako run ${verb.name}`, ...flags].join(' ');
}

/* ── 参数解析 ───────────────────────────────────────────── */

export interface ResolvedParams {
  values: ParameterValues;
  missing: string[];
}

export function resolveParams(verb: Verb, provided: ParameterValues): ResolvedParams {
  const values: ParameterValues = {};
  const missing: string[] = [];

  for (const param of verb.params) {
    let value = provided[param.name];

    if (value === undefined && param.secret) {
      const envName = secretEnvName(param.name);
      if (process.env[envName] !== undefined) value = process.env[envName];
    }
    if (value === undefined && param.default !== undefined) value = param.default;
    if (value === undefined) {
      if (param.required) missing.push(param.name);
      continue;
    }
    if (value === null && !param.required) continue;
    values[param.name] = coerce(verb, param.name, param.type, value);
  }

  return { values, missing };
}

export function secretEnvName(paramName: string): string {
  return `TAKO_SECRET_${paramName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;
}

function coerce(verb: Verb, name: string, type: string, value: unknown): unknown {
  switch (type) {
    case 'number': {
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(num)) {
        throw new TakoError(`动词 ${verb.name} 的参数 ${name} 需要数字，收到 "${String(value)}"。`, 'PARAM_TYPE');
      }
      return num;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const text = String(value).toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(text)) return true;
      if (['false', '0', 'no', 'off'].includes(text)) return false;
      throw new TakoError(`动词 ${verb.name} 的参数 ${name} 需要布尔值，收到 "${String(value)}"。`, 'PARAM_TYPE');
    }
    case 'object':
    case 'array': {
      if (typeof value === 'object') return value;
      try {
        return JSON.parse(String(value)) as unknown;
      } catch {
        throw new TakoError(
          `动词 ${verb.name} 的参数 ${name} 需要合法 JSON，例如 ${JSON.stringify(exampleOf(verb, name) ?? {})}`,
          'PARAM_TYPE',
        );
      }
    }
    default:
      return String(value);
  }
}

function exampleOf(verb: Verb, name: string): unknown {
  return verb.params.find((param) => param.name === name)?.example;
}

/* ── http 适配器 ────────────────────────────────────────── */

const httpAdapter: Adapter = {
  plan(context: AdapterContext): HttpPlan {
    const { arm, verb, values } = context;
    const action = requireHttpAction(verb);
    return {
      kind: 'http',
      method: action.method,
      url: buildUrl(arm, verb, values, action.path).toString(),
      headers: redactHeaders(buildHeaders(arm, verb, values, action, false)),
      body: pickBody(verb, values),
    };
  },

  async invoke(context: InvokeContext): Promise<AdapterResult> {
    const { arm, verb, values, log } = context;
    const action = requireHttpAction(verb);
    const url = buildUrl(arm, verb, values, action.path);
    const body = pickBody(verb, values);

    log(`${action.method} ${url}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), verb.timeoutMs);

    try {
      const response = await fetch(url, {
        method: action.method,
        headers: buildHeaders(arm, verb, values, action, true),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      const data = parseBody(text, response.headers.get('content-type') ?? '');

      if (!response.ok) {
        throw new TakoError(
          `${action.method} ${url.pathname} 返回 ${response.status}：${truncate(text, 300)}`,
          'HTTP_STATUS',
          { status: response.status, data },
        );
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };
    } catch (error) {
      if (error instanceof TakoError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TakoError(`请求超时（${verb.timeoutMs}ms）：${url}`, 'HTTP_TIMEOUT');
      }
      throw new TakoError(`请求失败：${error instanceof Error ? error.message : String(error)}`, 'HTTP_FAILED');
    } finally {
      clearTimeout(timer);
    }
  },
};

interface HttpAction {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
}

function requireHttpAction(verb: Verb): HttpAction {
  const { method, path, headers } = verb.action;
  if (!path) {
    throw new TakoError(`动词 ${verb.name} 没有 action.path，无法用 http 适配器执行。`, 'ACTION_INVALID');
  }
  return { method: method ?? 'GET', path, headers: headers ?? {} };
}

function buildUrl(arm: Arm, verb: Verb, values: ParameterValues, actionPath: string): URL {
  if (!arm.baseUrl) {
    throw new TakoError(`arm ${arm.name} 缺少 baseUrl。`, 'ARM_INVALID');
  }

  const base = expandEnv(arm.baseUrl).replace(/\/$/, '');
  let template = actionPath;

  for (const param of verb.params) {
    if (param.in !== 'path') continue;
    const value = values[param.name];
    if (value === undefined) continue;
    const encoded = encodeURIComponent(String(value));
    template = template
      .replace(new RegExp(`:${param.name}\\b`, 'g'), encoded)
      .replace(new RegExp(`\\{${param.name}\\}`, 'g'), encoded);
  }

  const url = new URL(base + template);
  for (const param of verb.params) {
    if (param.in !== 'query') continue;
    const value = values[param.name];
    if (value === undefined) continue;
    url.searchParams.set(param.name, String(value));
  }
  return url;
}

function buildHeaders(
  arm: Arm,
  verb: Verb,
  values: ParameterValues,
  action: HttpAction,
  strict: boolean,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', ...action.headers };

  for (const param of verb.params) {
    if (param.in !== 'header') continue;
    const value = values[param.name];
    if (value !== undefined) headers[param.name] = String(value);
  }

  return Object.assign(headers, resolveAuth(arm, strict));
}

/**
 * 鉴权注入。strict=false 时用于 --dry-run 预览：不要求令牌真实存在，
 * 只展示「会从哪里取令牌」；strict=true 时令牌缺失直接抛 AUTH_MISSING。
 */
function resolveAuth(arm: Arm, strict: boolean): Record<string, string> {
  const auth = arm.auth;
  if (auth.type === 'none') return {};

  const token = auth.tokenEnv ? process.env[auth.tokenEnv] : undefined;
  if (!token) {
    if (strict) {
      throw new TakoError(
        `arm "${arm.name}" 需要鉴权，但环境变量 ${auth.tokenEnv ?? '（未声明）'} 未设置。\n` +
          `  设置后重试：export ${auth.tokenEnv ?? 'TOKEN'}=<token>`,
        'AUTH_MISSING',
      );
    }
    const placeholder = `«export ${auth.tokenEnv ?? '<未声明环境变量>'} 后注入»`;
    switch (auth.type) {
      case 'bearer':
        return { Authorization: placeholder };
      case 'header':
        return { [auth.header ?? 'X-Api-Key']: placeholder };
      case 'cookie':
        return { Cookie: placeholder };
      case 'basic':
        return { Authorization: `Basic ${placeholder}` };
      default:
        throw new TakoError(`未支持的鉴权类型：${String(auth.type)}`, 'AUTH_UNKNOWN');
    }
  }

  switch (auth.type) {
    case 'bearer':
      return { Authorization: `${(auth.prefix ?? 'Bearer').trim()} ${token}` };
    case 'header':
      return { [auth.header ?? 'X-Api-Key']: token };
    case 'cookie':
      return { Cookie: token };
    case 'basic':
      return { Authorization: `Basic ${token}` };
    default:
      throw new TakoError(`未支持的鉴权类型：${String(auth.type)}`, 'AUTH_UNKNOWN');
  }
}

function pickBody(verb: Verb, values: ParameterValues): unknown {
  const bodyParams = verb.params.filter((param) => param.in === 'body');
  const first = bodyParams[0];
  if (!first) return undefined;
  if (bodyParams.length === 1) return values[first.name];

  return Object.fromEntries(
    bodyParams.filter((param) => values[param.name] !== undefined).map((param) => [param.name, values[param.name]]),
  );
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const clone: Record<string, string> = { ...headers };
  for (const key of Object.keys(clone)) {
    // 值以 « 开头的是“注入说明”占位符（如 «export X 后注入»），不是真实密钥，不再脱敏
    if (/authorization|cookie|token|key|secret/i.test(key) && !clone[key]?.startsWith('«')) {
      clone[key] = '«redacted»';
    }
  }
  return clone;
}

function expandEnv(value: string): string {
  return value.replace(/\$?\{([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? '');
}

/* ── script 适配器 ──────────────────────────────────────── */

const scriptAdapter: Adapter = {
  plan(context: AdapterContext): ScriptPlan {
    const { manifest, verb, values } = context;
    const script = requireScript(verb);
    return {
      kind: 'script',
      script,
      resolvedPath: path.resolve(manifest.dir, script),
      args: values,
    };
  },

  async invoke(context: InvokeContext): Promise<AdapterResult> {
    const { manifest, verb, values, log } = context;
    const script = requireScript(verb);
    const scriptPath = path.resolve(manifest.dir, script);

    if (!scriptPath.startsWith(manifest.dir)) {
      throw new TakoError(`脚本必须位于清单目录内：${script}`, 'SCRIPT_ESCAPE');
    }
    if (!fileExists(scriptPath)) {
      throw new TakoError(`脚本不存在：${scriptPath}`, 'SCRIPT_NOT_FOUND');
    }

    // 带上时间戳，避免开发期改了脚本但 ESM 缓存住旧版本
    const module = (await import(`${pathToFileURL(scriptPath).href}?t=${Date.now()}`)) as {
      default?: ScriptEntry;
    };
    const entry = module.default;
    if (typeof entry !== 'function') {
      throw new TakoError(`脚本 ${script} 必须 default export 一个函数。`, 'SCRIPT_INVALID');
    }

    log(`run script ${scriptPath}`);
    const scriptContext: ScriptContext = {
      params: values,
      verb,
      root: manifest.dir,
      log,
      readFile: (file) => readFileSync(path.resolve(manifest.dir, file), 'utf8'),
    };

    return { data: await entry(scriptContext) };
  },
};

function requireScript(verb: Verb): string {
  const script = verb.action.script;
  if (!script) {
    throw new TakoError(`动词 ${verb.name} 没有 action.script，无法用 script 适配器执行。`, 'ACTION_INVALID');
  }
  return script;
}

function fileExists(target: string): boolean {
  try {
    readFileSync(target, { flag: 'r' });
    return true;
  } catch {
    return false;
  }
}

/* ── browser 适配器（接口预留） ─────────────────────────── */

const browserAdapter: Adapter = {
  plan(context: AdapterContext): BrowserPlan {
    return {
      kind: 'browser',
      flow: context.verb.action.flow ?? context.verb.name,
      note: '需要浏览器适配器插件',
    };
  },

  async invoke(context: InvokeContext): Promise<AdapterResult> {
    throw new TakoError(
      `browser 适配器尚未内置（动词 ${context.verb.name}）。安装插件：npm i takocli-adapter-browser，` +
        '或先用 `tako capture` 把网页操作录成 http 能力。',
      'ADAPTER_NOT_INSTALLED',
    );
  },
};

/** 适配器表在调用时解析，避开模块初始化顺序问题 */
function adapterFor(name: string): Adapter | undefined {
  return ({ http: httpAdapter, script: scriptAdapter, browser: browserAdapter } as Record<string, Adapter>)[name];
}

/* ── 小工具 ─────────────────────────────────────────────── */

function parseBody(text: string, contentType: string): unknown {
  if (!text) return null;
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 供外部（如未来的控制台）复用适配器表 */
export const adapters: Readonly<Record<string, Adapter>> = {
  http: httpAdapter,
  script: scriptAdapter,
  browser: browserAdapter,
};
