/**
 * ask —— 本地意图匹配：把一句人话映射到清单里的动词。
 *
 * 为什么它只能是「best-effort」，而不是主入口：
 *   真正的「自然语言 → 动词」路由应该发生在 Agent 层（LLM 读 aiExample 做语义匹配），
 *   Tako 的主路径也是那条（tako context / tako integrate）。
 *   往 CLI 里塞 LLM 会打破「运行时依赖为 0」这条设计底线。
 *
 *   但在纯终端里，人只想敲一句话就拿到该跑的命令。所以这里做一个**零依赖的
 *   本地打分匹配**：不保证语义准确，只保证确定性、可解释（给出打分依据）。
 *
 * 打分策略（全部来自清单，不硬编码任何动词名）：
 *   · 字段权重：name > tags > aiExample > description
 *   · 中英文都切：ASCII 词 + 中文二元组（中文没有空格，二元组是最稳的近似）
 *   · 完全包含整句时额外加权，避免「查提交」被「查记录」抢走
 */

import type { Manifest, Verb } from './types.js';

export interface AskHit {
  verb: Verb;
  score: number;
  /** 命中的词，用来解释「为什么是它」 */
  matched: string[];
  /** 直接可跑的命令 */
  command: string;
}

export interface AskOptions {
  /** 返回前 N 条（默认 3） */
  top?: number;
  /** 分数低于此值不返回（默认 0） */
  minScore?: number;
}

const FIELD_WEIGHTS = {
  name: 6,
  tags: 4,
  aiExample: 2.5,
  description: 1.8,
} as const;

/** 中文二元组 + ASCII 词。中文不做分词，二元组足够稳 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  for (const word of lower.match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []) tokens.push(word);

  // 中文按二元组切：连续汉字段落 "查看最近提交" → 查看/看最/最近/近提/提交
  for (const run of lower.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }

  return [...new Set(tokens)];
}

/** 对单个动词打分 */
export function scoreVerb(verb: Verb, query: string, tokens: readonly string[]): AskHit {
  const fields: readonly (readonly [string, number])[] = [
    [verb.name.toLowerCase(), FIELD_WEIGHTS.name],
    [verb.tags.join(' ').toLowerCase(), FIELD_WEIGHTS.tags],
    [verb.aiExample.toLowerCase(), FIELD_WEIGHTS.aiExample],
    [verb.description.toLowerCase(), FIELD_WEIGHTS.description],
  ];

  let score = 0;
  const matched = new Set<string>();

  for (const token of tokens) {
    for (const [haystack, weight] of fields) {
      if (!haystack) continue;
      const hits = countOccurrences(haystack, token);
      if (hits === 0) continue;
      // 同一个词在多个字段命中就叠加，但单字段重复出现不无限加分
      score += weight;
      matched.add(token);
    }
  }

  // 整句被子串包含：强烈信号（例如用户直接复述了 aiExample 里的说法）
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length >= 2) {
    for (const [haystack, weight] of fields) {
      if (haystack.includes(normalizedQuery)) score += weight * 2;
    }
  }

  return {
    verb,
    score: Math.round(score * 100) / 100,
    matched: [...matched],
    command: toRunCommand(verb),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 按分数排序返回候选。分数为 0 的不会出现 —— 宁可不猜，也不误导 */
export function askManifest(manifest: Manifest, query: string, options: AskOptions = {}): AskHit[] {
  const top = options.top ?? 3;
  const minScore = options.minScore ?? 0;
  const tokens = tokenize(query);

  if (tokens.length === 0) return [];

  return manifest.verbs
    .map((verb) => scoreVerb(verb, query, tokens))
    .filter((hit) => hit.score > minScore)
    .sort((a, b) => b.score - a.score || a.verb.name.localeCompare(b.verb.name))
    .slice(0, top);
}

/** 只提示必填参数，避免给出跑不起来的命令 */
export function toRunCommand(verb: Verb): string {
  const parts = [`tako run ${verb.name}`];
  for (const param of verb.params) {
    if (!param.required) continue;
    parts.push(param.type === 'boolean' ? `--${param.name}` : `--${param.name} <${param.type}>`);
  }
  const optional = verb.params.filter((param) => !param.required);
  if (optional.length > 0) parts.push(`[可选：${optional.map((p) => `--${p.name}`).join(' ')}]`);
  return parts.join(' ');
}
