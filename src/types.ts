/**
 * Tako 的领域类型 —— 「三端同源」的类型契约。
 *
 * 清单、执行、投影（GUI 表单 / CLI 用法 / Agent 工具定义）全部基于这里定义的类型。
 * 未来做可视化控制台时，直接 import 这些类型即可，不需要重新描述一遍数据形状。
 */

/* ── 枚举与取值集合 ─────────────────────────────────────── */

export type RiskLevel = 'read' | 'write' | 'destructive';
export type ParamType = 'string' | 'number' | 'boolean' | 'object' | 'array';
export type ParamLocation = 'query' | 'path' | 'body' | 'header' | 'arg';
export type AdapterName = 'http' | 'script' | 'browser';
export type AuthType = 'none' | 'bearer' | 'header' | 'cookie' | 'basic';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export const RISK_LEVELS = ['read', 'write', 'destructive'] as const satisfies readonly RiskLevel[];
export const PARAM_TYPES = ['string', 'number', 'boolean', 'object', 'array'] as const satisfies readonly ParamType[];
export const PARAM_LOCATIONS = [
  'query',
  'path',
  'body',
  'header',
  'arg',
] as const satisfies readonly ParamLocation[];
export const ADAPTER_NAMES = ['http', 'script', 'browser'] as const satisfies readonly AdapterName[];
export const AUTH_TYPES = ['none', 'bearer', 'header', 'cookie', 'basic'] as const satisfies readonly AuthType[];
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const satisfies readonly HttpMethod[];

export const isRiskLevel = (value: unknown): value is RiskLevel =>
  RISK_LEVELS.some((level) => level === value);

export const isAdapterName = (value: unknown): value is AdapterName =>
  ADAPTER_NAMES.some((name) => name === value);

export const isParamType = (value: unknown): value is ParamType =>
  PARAM_TYPES.some((name) => name === value);

export const isParamLocation = (value: unknown): value is ParamLocation =>
  PARAM_LOCATIONS.some((name) => name === value);

export const isAuthType = (value: unknown): value is AuthType =>
  AUTH_TYPES.some((name) => name === value);

/* ── 清单结构 ───────────────────────────────────────────── */

/** 鉴权声明：只写「去哪里取令牌」，永远不写令牌本身 */
export interface AuthConfig {
  type: AuthType;
  /** 令牌所在的环境变量名 */
  tokenEnv?: string;
  /** 令牌前缀，默认 Bearer */
  prefix?: string;
  /** type=header 时使用的请求头名 */
  header?: string;
}

/** 连接（arm）：一条到某个平台的接入配置（地址 + 适配器 + 鉴权） */
export interface Arm {
  name: string;
  adapter: AdapterName;
  /** 仅 http 适配器需要，支持 ${ENV_VAR} 插值 */
  baseUrl?: string;
  description: string;
  auth: AuthConfig;
}

export interface VerbAction {
  method?: HttpMethod;
  /** 支持 :name 与 {name} 占位符 */
  path?: string;
  headers?: Record<string, string>;
  /** script 适配器入口，相对清单目录 */
  script?: string;
  /** browser 适配器的声明式操作序列标识 */
  flow?: string;
  /** browser 适配器：内联的声明式操作序列，由插件负责执行 */
  steps?: readonly BrowserStep[];
  /** 传给 browser 插件的额外配置（如登录态、视口） */
  driverOptions?: Record<string, unknown>;
}

export interface Param {
  name: string;
  type: ParamType;
  in: ParamLocation;
  required: boolean;
  default?: unknown;
  description: string;
  example?: unknown;
  enum?: readonly unknown[];
  /** 为 true 时从 TAKO_SECRET_<NAME> 读取，且输出中脱敏 */
  secret: boolean;
}

/** 动词：一条可被调用的能力 */
export interface Verb {
  /** 即命令名 */
  name: string;
  arm: string;
  /** 一句话说明这条能力做什么 */
  description: string;
  /** Agent 判断「何时该调用」的语境说明 */
  aiExample: string;
  risk: RiskLevel;
  idempotent: boolean;
  timeoutMs: number;
  tags: readonly string[];
  action: VerbAction;
  params: readonly Param[];
}

export interface ManifestDefaults {
  risk?: RiskLevel;
  timeoutMs?: number;
  arm?: string;
}

/** 归一化之后的清单：所有可选字段都已补齐默认值 */
export interface Manifest {
  formatVersion: number;
  project: string;
  description: string;
  defaults: ManifestDefaults;
  arms: readonly Arm[];
  verbs: readonly Verb[];
  /** 清单绝对路径 */
  file: string;
  /** 清单所在目录，script 适配器据此解析相对路径 */
  dir: string;
  armByName: ReadonlyMap<string, Arm>;
  verbByName: ReadonlyMap<string, Verb>;
}

/* ── 执行 ───────────────────────────────────────────────── */

export type ParameterValues = Record<string, unknown>;

export interface HttpPlan {
  kind: 'http';
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ScriptPlan {
  kind: 'script';
  script: string;
  resolvedPath: string;
  args: ParameterValues;
}

export interface BrowserPlan {
  kind: 'browser';
  flow: string;
  /** 将要执行的步骤数（供 --dry-run 预览） */
  steps?: readonly BrowserStep[];
  note: string;
}

export type Plan = HttpPlan | ScriptPlan | BrowserPlan;

export interface ExecutionResult {
  ok: true;
  dryRun: boolean;
  verb: string;
  arm: string;
  risk?: RiskLevel;
  durationMs?: number;
  /** --dry-run 下即为将要执行的计划 */
  plan: Plan;
  status?: number;
  headers?: Record<string, string>;
  data?: unknown;
}

export interface ExecutionOptions {
  dryRun?: boolean;
  log?: (line: string) => void;
}

/* ── browser 适配器：声明式步骤 + 驱动插件契约 ─────────── */

/**
 * 一个步骤就是一条指令。字符串值里写 `{{参数名}}` 会被该动词的参数替换。
 * 刻意保持极小：只覆盖「打开页面 → 操作 → 取值」这类窄流程。
 */
export type BrowserStep =
  | { goto: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { click: string }
  | { fill: string; value: string }
  | { press: string; key: string }
  | { waitFor: string; timeoutMs?: number }
  | { wait: number }
  /** 取多个元素文本；不写 as 时结果并入 outputs.texts */
  | { texts: string; as?: string }
  /** 取单个元素文本 */
  | { text: string; as: string }
  /** 取属性值 */
  | { attribute: string; name: string; as: string }
  | { count: string; as: string }
  /** 在页面里求值，结果作为 outputs[as ?? 'result'] */
  | { eval: string; as?: string }
  /** 截图存盘（相对清单目录） */
  | { screenshot: string };

/** 插件收到的执行入参：核心已经把参数替换、鉴权准备好 */
 export interface BrowserRunInput {
  /** 步骤里所有 `{{name}}` 已被替换 */
  steps: readonly BrowserStep[];
  flow: string;
  verb: Verb;
  arm: Arm;
  /** 原始参数值（未被替换），插件可自行使用 */
  values: ParameterValues;
  timeoutMs: number;
  /** 清单所在目录：截图等产物写在这里 */
  rootDir: string;
  driverOptions: Record<string, unknown>;
  log: (line: string) => void;
}

export interface BrowserRunResult {
  /** 最终停留的页面地址 */
  url: string;
  /** 步骤里通过 as 命名的产物 */
  outputs: Record<string, unknown>;
}

/** 插件只需实现 run；capture 留给 `tako capture` 使用 */
export interface BrowserDriver {
  run(input: BrowserRunInput): Promise<BrowserRunResult>;
  capture?(input: BrowserCaptureInput): Promise<BrowserCaptureResult>;
  close?(): Promise<void>;
}

export interface BrowserCaptureInput {
  startUrl?: string;
  rootDir: string;
  /** 录制多久后自动结束（毫秒），默认 30000 */
  durationMs?: number;
  log: (line: string) => void;
}

/** 录到的一次交互：足够反推出一个 http 动词 */
export interface BrowserCaptureResult {
  /** 页面地址 */
  url: string;
  requests: readonly CapturedRequest[];
}

export interface CapturedRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  /** Playwright 的资源类型（xhr / fetch / document / script…）；只抓接口时靠它过滤 */
  resourceType?: string;
  /** 请求体（JSON 会被解析） */
  body?: unknown;
  status?: number;
  /** 响应体（JSON 会被解析） */
  response?: unknown;
}

export interface BrowserDriverOptions {
  /** 清单所在目录，插件据此解析相对路径与配置 */
  rootDir: string;
  log: (line: string) => void;
}

/** 插件 default export 的形状：一个工厂 */
export type BrowserDriverFactory = (
  options: BrowserDriverOptions,
) => BrowserDriver | Promise<BrowserDriver>;

/* ── 适配器契约 ─────────────────────────────────────────── */

export interface AdapterContext {
  manifest: Manifest;
  arm: Arm;
  verb: Verb;
  values: ParameterValues;
}

export interface InvokeContext extends AdapterContext {
  log: (line: string) => void;
}

export interface AdapterResult {
  data: unknown;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * 加一种执行方式 = 实现一个 Adapter 对象。
 * plan 必须无副作用且可 JSON 序列化，否则 --dry-run 就失去意义。
 */
export interface Adapter {
  plan(context: AdapterContext): Plan | Promise<Plan>;
  invoke(context: InvokeContext): Promise<AdapterResult>;
}

/* ── script 适配器的用户态契约 ─────────────────────────── */

/** script 能力收到的上下文 */
export interface ScriptContext {
  params: ParameterValues;
  verb: Verb;
  /** 清单所在目录（项目根）。脚本应基于它解析路径，而不是 process.cwd() */
  root: string;
  log: (line: string) => void;
  /** 读文本文件；相对路径基于 root 解析 */
  readFile: (file: string) => string;
}

/** script 文件的 default export */
export type ScriptEntry = (context: ScriptContext) => unknown | Promise<unknown>;

/* ── 投影：GUI / CLI / Agent ───────────────────────────── */

export type FormWidget = 'text' | 'number' | 'switch' | 'select' | 'code';

export interface FormField {
  name: string;
  label: string;
  widget: FormWidget;
  options?: readonly unknown[];
  required: boolean;
  defaultValue?: unknown;
  placeholder: string;
  masked: boolean;
}

/** GUI 该渲染什么控件 */
export interface FormSpec {
  title: string;
  description: string;
  submitLabel: string;
  fields: readonly FormField[];
}

/** Agent 该注册成什么工具（OpenAI function calling 形状） */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: false;
    };
    'x-tako': {
      verb: string;
      arm: string;
      risk: RiskLevel;
      idempotent: boolean;
      cli: string;
    };
  };
}

/* ── 错误码 ─────────────────────────────────────────────── */

export type TakoErrorCode =
  | 'TAKO_ERROR'
  | 'USAGE'
  | 'MANIFEST_NOT_FOUND'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_INVALID_JSON'
  | 'VERB_NOT_FOUND'
  | 'PARAM_UNKNOWN'
  | 'PARAM_MISSING'
  | 'PARAM_TYPE'
  | 'ADAPTER_UNKNOWN'
  | 'ADAPTER_NOT_INSTALLED'
  | 'DRIVER_NOT_FOUND'
  | 'DRIVER_INVALID'
  | 'ARM_INVALID'
  | 'ACTION_INVALID'
  | 'AUTH_MISSING'
  | 'AUTH_UNKNOWN'
  | 'HTTP_STATUS'
  | 'HTTP_TIMEOUT'
  | 'HTTP_FAILED'
  | 'SCRIPT_NOT_FOUND'
  | 'SCRIPT_INVALID'
  | 'SCRIPT_ESCAPE'
  | 'PACK_NOT_FOUND'
  | 'PACK_CONFLICT';
