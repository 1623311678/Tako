/**
 * 清单层：加载 tako.json → 校验 → 归一化 → 投影成三种消费者所需的视图。
 *
 * 这一层是「三端同源」的落点：
 *   toCliUsage()   → 人类在终端里怎么敲
 *   toFormSpec()   → GUI 该怎么渲染表单
 *   toToolSpecs()  → Agent 该怎么注册工具
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  RISK_LEVELS,
  isAdapterName,
  isParamLocation,
  isParamType,
  isRiskLevel,
  type AdapterName,
  type Arm,
  type AuthConfig,
  type FormSpec,
  type FormWidget,
  type HttpMethod,
  type Manifest,
  type ManifestDefaults,
  type Param,
  type ParamLocation,
  type ParamType,
  type RiskLevel,
  type TakoErrorCode,
  type ToolSpec,
  type Verb,
  type VerbAction,
} from './types.js';

export { RISK_LEVELS };

export class TakoError extends Error {
  readonly code: TakoErrorCode;
  readonly details: unknown;

  constructor(message: string, code: TakoErrorCode = 'TAKO_ERROR', details?: unknown) {
    super(message);
    this.name = 'TakoError';
    this.code = code;
    this.details = details;
  }
}

/* ── 未校验的原始输入 ───────────────────────────────────── */

/**
 * JSON.parse 的结果是不可信输入，这里只描述「期望的形状」。
 * 真正的把关在 normalize() 里，字段缺失或非法都会被收集成问题清单。
 */
interface RawManifest {
  tako?: unknown;
  project?: unknown;
  description?: unknown;
  defaults?: ManifestDefaults;
  arms?: RawArm[];
  verbs?: RawVerb[];
}

interface RawArm {
  name?: unknown;
  adapter?: unknown;
  baseUrl?: unknown;
  description?: unknown;
  auth?: AuthConfig;
}

interface RawVerb {
  name?: unknown;
  arm?: unknown;
  description?: unknown;
  aiExample?: unknown;
  risk?: unknown;
  idempotent?: unknown;
  timeoutMs?: unknown;
  tags?: unknown;
  action?: VerbAction;
  params?: RawParam[];
}

interface RawParam {
  name?: unknown;
  type?: unknown;
  in?: unknown;
  required?: unknown;
  default?: unknown;
  description?: unknown;
  example?: unknown;
  enum?: unknown[];
  secret?: unknown;
}

/* ── 查找与加载 ─────────────────────────────────────────── */

export function findManifestPath(explicitPath?: string): string {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!existsSync(resolved)) {
      throw new TakoError(`找不到清单文件：${resolved}`, 'MANIFEST_NOT_FOUND');
    }
    return resolved;
  }

  if (process.env['TAKO_MANIFEST']) return findManifestPath(process.env['TAKO_MANIFEST']);

  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'tako.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new TakoError(
    '当前目录及上层目录都没有找到 tako.json。\n' +
      '  用 --file <path> 指定清单路径，或在项目根目录新建一份 tako.json（格式见 docs/design.md）。',
    'MANIFEST_NOT_FOUND',
  );
}

export function loadManifest(manifestPath?: string): Manifest {
  const file = findManifestPath(manifestPath);
  const text = readFileSync(file, 'utf8');
  return normalize(parseJson(text, file), file);
}

function parseJson(text: string, file: string): RawManifest {
  try {
    return JSON.parse(text) as RawManifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TakoError(
      `清单不是合法 JSON：${path.basename(file)}\n  ${message}${locateJsonError(text, message)}`,
      'MANIFEST_INVALID_JSON',
    );
  }
}

/** 根据 JSON.parse 报错里的偏移量，给出「第几行第几列 + 上下文」 */
function locateJsonError(text: string, message: string): string {
  const match = /position (\d+)/.exec(message);
  if (!match?.[1]) return '';

  const offset = Number(match[1]);
  const lines = text.split('\n');
  const before = text.slice(0, offset);
  const lineIndex = before.split('\n').length - 1;
  const column = offset - before.lastIndexOf('\n');

  const context: string[] = [];
  const previous = previousNonEmptyLine(lines, lineIndex);
  if (previous !== -1) {
    context.push(`  上一行：第 ${previous + 1} 行 → ${lines[previous]?.trim().slice(0, 120) ?? ''}`);
  }
  context.push(`  出错处：第 ${lineIndex + 1} 行第 ${column} 列 → ${lines[lineIndex]?.trim().slice(0, 120) ?? ''}`);
  context.push('  常见原因：上一行末尾多了一个逗号，或引号 / 括号未闭合');
  return `\n${context.join('\n')}`;
}

function previousNonEmptyLine(lines: readonly string[], index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    if (lines[i]?.trim()) return i;
  }
  return -1;
}

/* ── 校验与归一化 ───────────────────────────────────────── */

function normalize(raw: RawManifest, file: string): Manifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new TakoError('清单内容为空或不是对象。', 'MANIFEST_INVALID');
  }

  const problems: string[] = [];
  const asText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

  if (raw.tako !== 1) problems.push(`字段 tako 必须为 1（当前：${JSON.stringify(raw.tako)}）`);
  if (!asText(raw.project)) problems.push('缺少字段 project');
  if (!Array.isArray(raw.arms) || raw.arms.length === 0) problems.push('arms 至少需要一条');

  const defaults = raw.defaults ?? {};
  const arms: Arm[] = [];
  const armNames = new Set<string>();

  for (const rawArm of raw.arms ?? []) {
    const name = asText(rawArm.name);
    if (!name) {
      problems.push('存在没有 name 的 arm');
      continue;
    }
    if (armNames.has(name)) problems.push(`arm 名称重复：${name}`);
    armNames.add(name);

    const adapter = rawArm.adapter;
    if (!isAdapterName(adapter)) {
      problems.push(`arm ${name} 的 adapter 非法：${String(adapter)}`);
      continue;
    }

    arms.push({
      name,
      adapter: adapter satisfies AdapterName,
      baseUrl: asText(rawArm.baseUrl),
      description: asText(rawArm.description) ?? '',
      auth: rawArm.auth ?? { type: 'none' },
    });
  }

  const verbs: Verb[] = [];
  const verbNames = new Set<string>();

  for (const rawVerb of raw.verbs ?? []) {
    const name = asText(rawVerb.name);
    if (!name) {
      problems.push('存在没有 name 的 verb');
      continue;
    }
    if (verbNames.has(name)) problems.push(`verb 名称重复：${name}`);
    verbNames.add(name);

    const risk = pickRisk(rawVerb.risk, defaults.risk, name, problems);
    const arm = asText(rawVerb.arm);
    if (!arm || !armNames.has(arm)) {
      problems.push(`verb ${name} 引用了不存在的 arm：${String(rawVerb.arm)}`);
    }

    const action: VerbAction = rawVerb.action ?? {};
    const usesScript = Boolean(action.script);
    if (!usesScript && !action.path) {
      problems.push(`verb ${name} 缺少 action.path（或 action.script）`);
    }

    const params = normalizeParams(rawVerb.params ?? [], usesScript, name, problems);

    verbs.push({
      name,
      arm: arm ?? '',
      description: asText(rawVerb.description) ?? '',
      aiExample: asText(rawVerb.aiExample) ?? '',
      risk,
      idempotent: rawVerb.idempotent === undefined ? risk === 'read' : rawVerb.idempotent === true,
      timeoutMs: typeof rawVerb.timeoutMs === 'number' ? rawVerb.timeoutMs : (defaults.timeoutMs ?? 30_000),
      tags: Array.isArray(rawVerb.tags) ? rawVerb.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      action,
      params,
    });
  }

  if (verbs.length === 0) problems.push('verbs 至少需要一个');

  if (problems.length > 0) {
    throw new TakoError(
      `清单校验未通过（${problems.length} 个问题）：\n  · ${problems.join('\n  · ')}`,
      'MANIFEST_INVALID',
      { problems },
    );
  }

  return {
    formatVersion: 1,
    project: asText(raw.project) ?? '',
    description: asText(raw.description) ?? '',
    defaults,
    arms,
    verbs,
    file,
    dir: path.dirname(file),
    armByName: new Map(arms.map((arm) => [arm.name, arm])),
    verbByName: new Map(verbs.map((verb) => [verb.name, verb])),
  };
}

function pickRisk(
  raw: unknown,
  fallback: RiskLevel | undefined,
  verbName: string,
  problems: string[],
): RiskLevel {
  if (raw === undefined) return fallback ?? 'read';
  if (isRiskLevel(raw)) return raw;
  problems.push(`verb ${verbName} 的 risk 非法：${String(raw)}（可选 ${RISK_LEVELS.join(' / ')}）`);
  return 'read';
}

function normalizeParams(
  rawParams: readonly RawParam[],
  usesScript: boolean,
  verbName: string,
  problems: string[],
): Param[] {
  const params: Param[] = [];

  for (const rawParam of rawParams) {
    const name = typeof rawParam.name === 'string' ? rawParam.name : undefined;
    if (!name) {
      problems.push(`verb ${verbName} 存在没有 name 的 param`);
      continue;
    }

    const type: ParamType = isParamType(rawParam.type) ? rawParam.type : 'string';
    if (rawParam.type !== undefined && !isParamType(rawParam.type)) {
      problems.push(`verb ${verbName} 的 param ${name} 类型非法：${String(rawParam.type)}`);
    }

    const fallbackLocation: ParamLocation = usesScript ? 'arg' : 'query';
    const location: ParamLocation = isParamLocation(rawParam.in) ? rawParam.in : fallbackLocation;
    if (rawParam.in !== undefined && !isParamLocation(rawParam.in)) {
      problems.push(`verb ${verbName} 的 param ${name} 位置非法：${String(rawParam.in)}`);
    }

    const required = rawParam.required === true;
    if (required && rawParam.default !== undefined) {
      problems.push(`verb ${verbName} 的 param ${name} 同时声明了 required 与 default`);
    }

    params.push({
      name,
      type,
      in: location,
      required,
      default: rawParam.default,
      description: typeof rawParam.description === 'string' ? rawParam.description : '',
      example: rawParam.example,
      enum: Array.isArray(rawParam.enum) ? rawParam.enum : undefined,
      secret: rawParam.secret === true,
    });
  }

  return params;
}

/* ── 查询 ───────────────────────────────────────────────── */

export function requireVerb(manifest: Manifest, name: string): Verb {
  const verb = manifest.verbByName.get(name);
  if (verb) return verb;

  const suggestions = [...manifest.verbByName.keys()].filter((key) => key.includes(name));
  const hint = suggestions.length > 0 ? `\n  你是不是想找：${suggestions.join(', ')}` : '';
  throw new TakoError(`没有名为 "${name}" 的动词。执行 \`tako ls\` 查看全部。${hint}`, 'VERB_NOT_FOUND');
}

/* ── 投影一：命令行长什么样 ─────────────────────────────── */

export function toCliUsage(verb: Verb): string {
  const parts = [`tako run ${verb.name}`];
  for (const param of verb.params) {
    if (param.type === 'boolean') {
      parts.push(param.required ? `--${param.name}` : `[--${param.name}]`);
      continue;
    }
    parts.push(param.required ? `--${param.name} <${param.type}>` : `[--${param.name} <${param.type}>]`);
  }
  return parts.join(' ');
}

/* ── 投影二：GUI 该渲染什么控件 ─────────────────────────── */

export function toFormSpec(verb: Verb): FormSpec {
  return {
    title: verb.name,
    description: verb.description,
    submitLabel: verb.risk === 'destructive' ? '确认执行（危险）' : '执行',
    fields: verb.params.map((param) => ({
      name: param.name,
      label: param.description || param.name,
      widget: pickWidget(param),
      options: param.enum,
      required: param.required,
      defaultValue: param.default,
      placeholder: param.example === undefined ? '' : JSON.stringify(param.example),
      masked: param.secret,
    })),
  };
}

function pickWidget(param: Param): FormWidget {
  if (param.enum) return 'select';
  if (param.type === 'boolean') return 'switch';
  if (param.type === 'object' || param.type === 'array') return 'code';
  if (param.type === 'number') return 'number';
  return 'text';
}

/* ── 投影三：Agent 该注册成什么工具 ─────────────────────── */

export function toToolSpecs(manifest: Manifest): ToolSpec[] {
  return manifest.verbs.map((verb) => ({
    type: 'function' as const,
    function: {
      name: verb.name.replace(/[.-]/g, '_'),
      description: [verb.description, verb.aiExample].filter(Boolean).join(' '),
      parameters: {
        type: 'object' as const,
        properties: Object.fromEntries(
          verb.params.map((param) => [
            param.name,
            {
              type: jsonSchemaType(param.type),
              description: param.description,
              ...(param.enum ? { enum: param.enum } : {}),
              ...(param.default !== undefined ? { default: param.default } : {}),
            },
          ]),
        ),
        required: verb.params.filter((param) => param.required).map((param) => param.name),
        additionalProperties: false as const,
      },
      'x-tako': {
        verb: verb.name,
        arm: verb.arm,
        risk: verb.risk,
        idempotent: verb.idempotent,
        cli: toCliUsage(verb),
      },
    },
  }));
}

function jsonSchemaType(type: ParamType): 'string' | 'number' | 'boolean' | 'object' | 'array' {
  return type;
}

/** 供 CLI 使用的 http 方法归一化 */
export function httpMethodOf(verb: Verb): HttpMethod {
  return verb.action.method ?? 'GET';
}
