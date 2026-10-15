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

export { adapters, execute, interpolateSteps, resolveParams, secretEnvName, usageFor } from './run.js';

/** browser 驱动插件：加载与探测（核心不含驱动，只负责找它） */
export {
  BROWSER_PLUGIN_ENV,
  BROWSER_PLUGIN_LOCAL_FILE,
  BROWSER_PLUGIN_NAMES,
  loadBrowserDriver,
  probeBrowserPlugin,
} from './driver.js';
export type { DriverLoadReport, ResolvedPlugin } from './driver.js';

/** capture：录制请求 → 反推 http 动词 */
export { capture, deriveVerbs, mergeCapture, toFragment } from './capture.js';
export type {
  CaptureOptions,
  CaptureOutcome,
  DerivedArm,
  DerivedParam,
  DerivedVerb,
} from './capture.js';

/** verify：能力是否真能跑 */
export { summarize, verifyManifest, verifyVerbs } from './verify.js';
export type { VerifyCheck, VerifyOptions, VerifyReport, VerifySummary } from './verify.js';

/** 能力仓库（git 就是仓库，不另搭服务） */
export { buildPack, commitRepo, listRepo, looksLikeGit, readIndex, resolveRepo } from './repo.js';
export type {
  CapabilityPackMeta,
  PushOptions,
  PushResult,
  RepoIndex,
  RepoListing,
  ResolvedRepo,
} from './repo.js';

/** 本地控制台：页面数据全部来自上面的公共 API */
export { startConsole } from './console.js';
export type { ConsoleHandle, ConsoleOptions } from './console.js';

export type { ResolvedParams } from './run.js';
