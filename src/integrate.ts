/**
 * Agent 接入（integrate）—— 把「让 AI 会用 tako」从手工配置变成一条命令。
 *
 * 为什么这层必须在核心代码里，而不是留给用户写脚本：
 *   Tako 主张「一份清单，GUI / CLI / Agent 三端同源」，但 GUI 与 CLI 都是自带的，
 *   只有 Agent 端过去要用户自己写 hook 脚本、自己改 settings.json —— 三端里最该
 *   产品化的一环，反而是唯一要手工搭的。
 *
 * 两种接入方式，对应两类 Agent：
 *
 *   hook（会话级注入）  Agent 支持生命周期 hook，会话启动时直接把清单塞进上下文。
 *                       命令是 `tako context --hook` —— 不写绝对路径，可提交 git，
 *                       队友装了 tako 就自动生效。
 *
 *   markdown（按需读取） Agent 不支持 hook，只会读项目里的说明文件。这时写入的不是
 *                       清单快照（会过期），而是一句「先跑 tako context」的指针 ——
 *                       能力清单永远现取，永不过期。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TakoError } from './manifest.js';

export type IntegrateScope = 'project' | 'user';
export type IntegrateKind = 'hook' | 'markdown';
export type IntegrateAction = 'created' | 'updated' | 'unchanged' | 'removed';
export type WriteFn = (file: string, content: string) => void;

export interface IntegrationTarget {
  id: string;
  title: string;
  description: string;
  kind: IntegrateKind;
  /** 项目级配置路径，相对清单所在目录 */
  projectPath: string;
  /** 用户级配置路径，~ 展开为 home；不支持用户级时不填 */
  userPath?: string;
}

/** hook 注册的命令。刻意不写 node / 绝对路径，这样配置可提交、可跨机器 */
export const DEFAULT_HOOK_COMMAND = 'tako context --hook';
export const DEFAULT_HOOK_TIMEOUT = 10;

export const INTEGRATION_TARGETS: readonly IntegrationTarget[] = [
  {
    id: 'claude-code',
    title: 'Claude Code / CodeFlicker',
    description: '注册 SessionStart hook，会话启动时自动注入能力清单',
    kind: 'hook',
    projectPath: '.claude/settings.json',
    userPath: '~/.claude/settings.json',
  },
  {
    id: 'agents-md',
    title: 'AGENTS.md（通用 Agent）',
    description: '在 AGENTS.md 写入托管区块，指引用 Agent 先执行 tako context',
    kind: 'markdown',
    projectPath: 'AGENTS.md',
  },
];

const MARK_BEGIN = '<!-- tako:begin';
const MARK_END = '<!-- tako:end -->';

export function listIntegrations(): readonly IntegrationTarget[] {
  return INTEGRATION_TARGETS;
}

export function resolveIntegration(id: string): IntegrationTarget {
  const target = INTEGRATION_TARGETS.find((item) => item.id === id);
  if (target) return target;

  const available = INTEGRATION_TARGETS.map((item) => item.id);
  throw new TakoError(
    `没有名为 "${id}" 的接入目标。\n  可用：${available.join(', ')}\n  查看全部：tako integrate --list`,
    'USAGE',
  );
}

/** 解析配置文件落点 */
export function integrationPath(
  target: IntegrationTarget,
  scope: IntegrateScope,
  rootDir: string,
): string {
  if (scope === 'user') {
    if (!target.userPath) {
      throw new TakoError(`接入目标 ${target.id} 只支持项目级（--scope project）。`, 'USAGE');
    }
    return expandHome(target.userPath);
  }
  return path.join(rootDir, target.projectPath);
}

export interface IntegrateOptions {
  target: IntegrationTarget;
  /** 配置落点基准：项目级取清单所在目录 */
  rootDir: string;
  scope?: IntegrateScope;
  /** 自定义 hook 命令（默认 tako context --hook） */
  command?: string;
  /** 从配置中移除本工具写入的条目 */
  remove?: boolean;
  /** 只计算结果，不写盘 */
  dryRun?: boolean;
}

export interface IntegrateResult {
  target: IntegrationTarget;
  file: string;
  action: IntegrateAction;
  command?: string;
  notes: string[];
}

export function integrate(options: IntegrateOptions): IntegrateResult {
  const { target, rootDir, remove = false, dryRun = false } = options;
  const scope = options.scope ?? 'project';
  const command = options.command ?? DEFAULT_HOOK_COMMAND;
  const file = integrationPath(target, scope, rootDir);
  const write: WriteFn = dryRun ? () => undefined : writeText;

  const result =
    target.kind === 'hook'
      ? integrateHook({ target, file, command, remove, write })
      : integrateMarkdown({ target, file, remove, write });

  if (dryRun) result.notes.push('（--dry-run：未写盘）');
  return result;
}

/* ── hook 目标：合并进 settings.json ─────────────────────── */

function integrateHook(input: {
  target: IntegrationTarget;
  file: string;
  command: string;
  remove: boolean;
  write: WriteFn;
}): IntegrateResult {
  const { target, file, command, remove, write } = input;
  const existed = existsSync(file);
  const settings = existed ? readJsonObject(file) : {};
  const notes: string[] = [];

  const hooks = asObject(settings['hooks']);
  const sessionStart = asArray(hooks['SessionStart']);
  const registered = countCommand(sessionStart, command);

  if (remove) {
    if (registered === 0) {
      return { target, file, action: 'unchanged', notes: ['配置里没有本工具写入的条目，无需移除'] };
    }
    hooks['SessionStart'] = removeCommand(sessionStart, command);
    settings['hooks'] = hooks;
    pruneEmptyHooks(settings);
    write(file, jsonText(settings));
    return { target, file, action: 'removed', notes };
  }

  if (registered > 0) {
    return { target, file, action: 'unchanged', command, notes: ['已注册，未重复写入'] };
  }

  hooks['SessionStart'] = [
    ...sessionStart,
    { hooks: [{ type: 'command', command, timeout: DEFAULT_HOOK_TIMEOUT }] },
  ];
  settings['hooks'] = hooks;

  notes.push(`hook 命令：${command}`);
  if (target.userPath) {
    notes.push('提示：--scope user 影响你自己的所有项目；--scope project 可提交 git 给团队共享');
  }

  write(file, jsonText(settings));
  return { target, file, action: existed ? 'updated' : 'created', command, notes };
}

function removeCommand(sessionStart: readonly unknown[], command: string): unknown[] {
  const next: unknown[] = [];
  for (const entry of sessionStart) {
    const entryObject = asObject(entry);
    // entry 里可能还有别的 hook，只摘掉属于本命令的那条，空 entry 才整体丢弃
    const kept = asArray(entryObject['hooks']).filter(
      (hook) => asObject(hook)['command'] !== command,
    );
    if (kept.length === 0) continue;
    next.push({ ...entryObject, hooks: kept });
  }
  return next;
}

function countCommand(sessionStart: readonly unknown[], command: string): number {
  let count = 0;
  for (const entry of sessionStart) {
    for (const hook of asArray(asObject(entry)['hooks'])) {
      if (asObject(hook)['command'] === command) count++;
    }
  }
  return count;
}

/** hooks 下所有事件都空了就把空的 hooks 也去掉，别留垃圾 */
function pruneEmptyHooks(settings: Record<string, unknown>): void {
  const hooks = asObject(settings['hooks']);
  for (const key of Object.keys(hooks)) {
    if (asArray(hooks[key]).length === 0) delete hooks[key];
  }
  if (Object.keys(hooks).length === 0) delete settings['hooks'];
}

/* ── markdown 目标：托管区块 ─────────────────────────────── */

function integrateMarkdown(input: {
  target: IntegrationTarget;
  file: string;
  remove: boolean;
  write: WriteFn;
}): IntegrateResult {
  const { target, file, remove, write } = input;
  const existed = existsSync(file);
  const current = existed ? readFileSync(file, 'utf8') : '';

  const beginIndex = current.indexOf(MARK_BEGIN);
  const endIndex = current.indexOf(MARK_END);
  const hasBlock = beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex;

  if (remove) {
    if (!hasBlock) return { target, file, action: 'unchanged', notes: ['文件里没有托管区块'] };
    const kept = (current.slice(0, beginIndex) + current.slice(endIndex + MARK_END.length))
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
    write(file, kept ? `${kept}\n` : '');
    return { target, file, action: 'removed', notes: [] };
  }

  const block = renderMarkdownBlock();
  const notes = [
    '该目标不支持 hook：写入的是「先跑 tako context」的指针，清单每次现取，不会过期',
  ];

  if (hasBlock) {
    const existing = current.slice(beginIndex, endIndex + MARK_END.length);
    if (existing === block) return { target, file, action: 'unchanged', notes };

    write(file, current.slice(0, beginIndex) + block + current.slice(endIndex + MARK_END.length));
    return { target, file, action: 'updated', notes };
  }

  const body = current.trimEnd();
  write(file, body ? `${body}\n\n${block}\n` : `${block}\n`);
  return { target, file, action: existed ? 'updated' : 'created', notes };
}

function renderMarkdownBlock(): string {
  return [
    `${MARK_BEGIN}（由 tako integrate 生成，请勿手动编辑） -->`,
    '## Tako 能力清单',
    '',
    '本项目的可调用能力声明在 `tako.json` 里。**当用户用自然语言描述系统操作时**',
    '（查看最近提交、扫代码待办、生成演示文稿、查询平台状态……），不要自己拼等价的',
    'shell 命令，而是先读取当前能力清单，按其中每条动词的 `aiExample` 匹配意图：',
    '',
    '```bash',
    'tako context            # 当前清单与「何时调用」说明',
    'tako ls                 # 动词一览',
    'tako describe <verb>    # 单个动词的参数与用法',
    'tako run <verb> --<参数> <值>   # 执行（写操作先加 --dry-run）',
    '```',
    '',
    '清单是唯一事实来源：清单里没有的能力，不要用 shell 敷衍，而是提示用户',
    '`tako add <pack>` 或往 `tako.json` 的 `verbs` 里加一条。',
    MARK_END,
  ].join('\n');
}

/* ── 小工具 ─────────────────────────────────────────────── */

function expandHome(target: string): string {
  return target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target;
}

function writeText(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonObject(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new TakoError(
      `${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}\n` +
        '  请先修好该文件，或手工添加 hook。',
      'USAGE',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TakoError(`${file} 的内容不是 JSON 对象，无法自动合并。`, 'USAGE');
  }
  return parsed as Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
