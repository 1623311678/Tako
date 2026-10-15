/**
 * 公共 API。
 *
 * CLI 用的就是这套 API，未来的可视化控制台也用它 ——
 * 「三端同源」不只是理念，而是同一个 npm 包里的同一组函数。
 */

export * from './types.js';

export {
  TakoError,
  findManifestPath,
  loadManifest,
  requireVerb,
  toCliUsage,
  toFormSpec,
  toToolSpecs,
} from './manifest.js';

/** 投影四：Agent 该看到什么（文本上下文，供 hook / AGENTS.md 使用） */
export { DEFAULT_MAX_VERBS, toAgentContext, toHookOutput, verbLabel } from './context.js';
export type { AgentContextOptions, HookOutput } from './context.js';

/** Agent 接入：把清单注册进 Agent 的 hook 或说明文件 */
export {
  DEFAULT_HOOK_COMMAND,
  DEFAULT_HOOK_TIMEOUT,
  INTEGRATION_TARGETS,
  integrate,
  integrationPath,
  listIntegrations,
  resolveIntegration,
} from './integrate.js';
export type {
  IntegrateAction,
  IntegrateKind,
  IntegrateOptions,
  IntegrateResult,
  IntegrateScope,
  IntegrationTarget,
} from './integrate.js';

/** 本地意图匹配：一句话 → 动词候选（best-effort，无 LLM） */
export { askManifest, scoreVerb, toRunCommand, tokenize } from './ask.js';
export type { AskHit, AskOptions } from './ask.js';

export { adapters, execute, resolveParams, secretEnvName, usageFor } from './run.js';

export type { ResolvedParams } from './run.js';
