/**
 * Agent 上下文投影 —— 把清单变成「一段能直接喂给 LLM 的话」。
 *
 * 为什么需要它：
 *   toToolSpecs() 输出的是「工具注册表」（function calling 形状），适合已经支持
 *   动态注册工具的运行时。但绝大多数 Agent（IDE 内置的、终端里的）只有一个
 *   能力：你说人话，它读上下文。它们拿不到 tools 数组，只能读文本。
 *
 *   所以清单需要第四种投影：toAgentContext()。
 *   GUI / CLI / Agent(tools) / Agent(context) —— 四端同源，同一个 Manifest。
 *
 * 关键设计：这里**不硬编码任何动词名**。做什么、什么时候调用，全部来自
 * tako.json 的 description 与 aiExample。往清单里加动词，本文件一行都不用改。
 */

import type { Manifest, Verb } from './types.js';

/** 默认最多列出多少条动词，超出只给计数，避免上下文过长 */
export const DEFAULT_MAX_VERBS = 60;

export interface AgentContextOptions {
  /** 最多列出多少条动词（默认 60） */
  maxVerbs?: number;
  /** 是否在动词行内联参数名与必填标记（默认 true） */
  includeParams?: boolean;
  /** 传入环境变量快照时，会提示哪些令牌尚未设置（保持函数纯函数性，默认不检查） */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * 投影四：Agent 该看到什么。
 *
 * 输出是一段自带解释的纯文本 —— 没有 JSON 转义、没有 schema，模型可以直接读。
 */
export function toAgentContext(manifest: Manifest, options: AgentContextOptions = {}): string {
  const maxVerbs = options.maxVerbs ?? DEFAULT_MAX_VERBS;
  const includeParams = options.includeParams ?? true;

  const shown = manifest.verbs.slice(0, maxVerbs);
  const hidden = manifest.verbs.length - shown.length;

  const lines: string[] = [];

  lines.push(`[tako] 当前目录已接入能力清单：${manifest.file}`);
  lines.push(
    `项目 ${manifest.project || '(未命名)'} · ${manifest.arms.length} 条连接 · ${manifest.verbs.length} 个动词。`,
  );
  lines.push('');
  lines.push('当用户用自然语言描述下列能力时，**优先用 tako 执行，不要自己拼等价的 shell / git 命令**：');
  lines.push('  调用  tako run <verb> --<参数> <值>');
  lines.push('  预览  写操作先加 --dry-run 看请求计划，确认无误再正式执行');
  lines.push('  确认  risk=destructive 的动词，先说明影响范围，经用户同意后才加 --yes');
  lines.push('  查参  tako describe <verb>（参数名即 --<name>；长文本用 @<文件路径> 传入）');
  lines.push('');
  lines.push('动词清单（verb[risk](必填参数*) —— 何时调用）：');

  for (const verb of shown) {
    lines.push(`  - ${verbLabel(verb, includeParams)} —— ${verbHint(verb)}`);
  }

  if (hidden > 0) lines.push(`  …（另有 ${hidden} 个动词，用 tako ls 查看）`);

  const pending = missingTokenEnvs(manifest, options.env);
  if (pending.length > 0) {
    lines.push('');
    lines.push(`注意：以下环境变量尚未设置，相关连接会执行失败 —— ${pending.join('、')}`);
  }

  lines.push('');
  lines.push(
    `清单是唯一事实来源：清单里没有的能力不要用 shell 敷衍，而是提示用户 —— ` +
      `装能力包 \`tako add <pack>\`，或往 ${manifest.file} 的 verbs 里加一条。`,
  );

  return lines.join('\n');
}

/** `item.update[write](id*, note*)`；read 级不标注，无参数不显示括号 */
export function verbLabel(verb: Verb, includeParams = true): string {
  const risk = verb.risk === 'read' ? '' : `[${verb.risk}]`;
  if (!includeParams || verb.params.length === 0) return `${verb.name}${risk}`;
  const params = verb.params.map((param) => (param.required ? `${param.name}*` : param.name));
  return `${verb.name}${risk}(${params.join(', ')})`;
}

/** 路由依据：优先 aiExample（写给 Agent 的），退回 description */
function verbHint(verb: Verb): string {
  return verb.aiExample || verb.description || '（清单未提供调用时机说明）';
}

/** 清单声明了但环境里缺失的令牌名 */
function missingTokenEnvs(
  manifest: Manifest,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string[] {
  if (!env) return [];
  return manifest.arms
    .filter((arm) => arm.auth.type !== 'none' && arm.auth.tokenEnv && !env[arm.auth.tokenEnv])
    .map((arm) => arm.auth.tokenEnv as string)
    .filter((name, index, all) => all.indexOf(name) === index);
}

/* ── Hook 适配 ──────────────────────────────────────────── */

/** hook 约定的返回形状：additionalContext 会被追加进对话上下文 */
export interface HookOutput {
  continue: true;
  additionalContext?: string;
}

/**
 * 把上下文包装成 hook 的 stdout 载荷。
 *
 * context 为空时返回「静默通过」——hook 绝不能因为 tako 的问题打断会话。
 */
export function toHookOutput(context: string | undefined): HookOutput {
  return context ? { continue: true, additionalContext: context } : { continue: true };
}
