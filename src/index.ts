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

export { adapters, execute, resolveParams, secretEnvName, usageFor } from './run.js';

export type { ResolvedParams } from './run.js';
