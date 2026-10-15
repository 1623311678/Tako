/**
 * browser 驱动插件加载器。
 *
 * 为什么驱动必须是插件，而不是内置：
 *   零依赖实现 CDP 需要自己写 WebSocket 帧协议（握手 + 掩码 + 分片），Node 20 也没有
 *   内置 WebSocket（Node 22 才有）。那意味着几百行安全敏感代码进核心，直接打破
 *   「运行时依赖为 0」这条不变量 —— 而那条不变量正是 tako 启动速度的来源。
 *
 *   所以分工是：核心负责「解析步骤 + 托管鉴权 + 找驱动」，驱动由插件提供。
 *   插件没装时不静默失败，而是把「找过哪些地方」原样告诉用户。
 *
 * 解析顺序（先具体后抽象，方便本地试验）：
 *   1. TAKO_BROWSER_PLUGIN      环境变量：模块名或文件路径
 *   2. <清单目录>/tako-browser.mjs   放一个文件就能用，不必发包
 *   3. <清单目录>/node_modules/…     在项目里 npm i
 *   4. 从 tako 自身位置解析           全局安装的插件
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TakoError } from './manifest.js';
import type { BrowserDriver, BrowserDriverFactory, BrowserDriverOptions } from './types.js';

/** 官方与社区的插件名，按优先级尝试 */
export const BROWSER_PLUGIN_NAMES = [
  '@hun-dun/tako-adapter-browser',
  'tako-adapter-browser',
] as const;

/** 清单目录下可直接放置的单文件插件 */
export const BROWSER_PLUGIN_LOCAL_FILE = 'tako-browser.mjs';

export const BROWSER_PLUGIN_ENV = 'TAKO_BROWSER_PLUGIN';

export interface ResolvedPlugin {
  /** 人类可读的来源说明，用于报错与 --verbose */
  specifier: string;
  /** 实际加载位置 */
  resolvedPath: string;
}

export interface DriverLoadReport {
  /** 依次尝试过的位置，报错时原样展示 */
  attempts: string[];
  plugin?: ResolvedPlugin;
}

/**
 * 找驱动。找不到时抛出带「找过哪些地方」的错误 ——
 * 这比一句 ADAPTER_NOT_INSTALLED 有用得多。
 */
export async function loadBrowserDriver(
  options: BrowserDriverOptions & { manifestDir: string },
): Promise<BrowserDriver> {
  const report = await resolveBrowserPlugin(options.manifestDir);

  if (!report.plugin) {
    throw new TakoError(
      '没有找到 browser 驱动插件。\n' +
        `  依次找过：\n${report.attempts.map((line) => `    · ${line}`).join('\n')}\n\n` +
        '  三种装法，任选其一：\n' +
        `    1. 在项目里装：      npm i -D tako-adapter-browser   （或用官方 Playwright 驱动）\n` +
        `    2. 放单文件：        在清单目录放 ${BROWSER_PLUGIN_LOCAL_FILE}\n` +
        `    3. 指定路径/模块名： export ${BROWSER_PLUGIN_ENV}=<模块名或文件路径>\n`,
      'DRIVER_NOT_FOUND',
      { attempts: report.attempts },
    );
  }

  options.log(`browser driver: ${report.plugin.specifier} (${report.plugin.resolvedPath})`);
  return instantiate(report.plugin, { rootDir: options.manifestDir, log: options.log });
}

/** 解析但不实例化，供 doctor / 诊断使用（不抛错） */
export async function probeBrowserPlugin(manifestDir: string): Promise<DriverLoadReport> {
  return resolveBrowserPlugin(manifestDir);
}

async function resolveBrowserPlugin(manifestDir: string): Promise<DriverLoadReport> {
  const attempts: string[] = [];
  const requireFromProject = createRequire(path.join(manifestDir, '.tako-resolve.js'));
  const requireFromTako = createRequire(import.meta.url);

  const explicit = process.env[BROWSER_PLUGIN_ENV]?.trim();
  if (explicit) {
    const hit = resolveOne(explicit, manifestDir, requireFromProject, requireFromTako);
    attempts.push(`${BROWSER_PLUGIN_ENV}=${explicit} → ${hit ?? '解析失败'}`);
    if (hit) return { attempts, plugin: { specifier: explicit, resolvedPath: hit } };
  }

  // 清单目录下的单文件插件：先把相对路径当文件试，再当包名试
  const localFile = path.join(manifestDir, BROWSER_PLUGIN_LOCAL_FILE);
  if (existsSync(localFile)) {
    attempts.push(`${localFile} → 命中`);
    return { attempts, plugin: { specifier: `./${BROWSER_PLUGIN_LOCAL_FILE}`, resolvedPath: localFile } };
  }
  attempts.push(`${localFile} → 不存在`);

  for (const name of BROWSER_PLUGIN_NAMES) {
    const hit = resolveOne(name, manifestDir, requireFromProject, requireFromTako);
    attempts.push(`${name} → ${hit ?? '未安装'}`);
    if (hit) return { attempts, plugin: { specifier: name, resolvedPath: hit } };
  }

  return { attempts };
}

/**
 * 把一个 specifier 解析成文件路径。
 * 相对路径按清单目录解析；包名先用项目、再用 tako 自身的位置。
 */
function resolveOne(
  specifier: string,
  manifestDir: string,
  requireFromProject: NodeRequire,
  requireFromTako: NodeRequire,
): string | undefined {
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    const target = path.isAbsolute(specifier) ? specifier : path.resolve(manifestDir, specifier);
    return existsSync(target) ? target : undefined;
  }

  for (const req of [requireFromProject, requireFromTako]) {
    try {
      return req.resolve(specifier);
    } catch {
      // 换下一个解析基准
    }
  }
  return undefined;
}

/** 插件 default export 可以是工厂函数，也可以是 createDriver 具名导出 */
async function instantiate(
  plugin: ResolvedPlugin,
  options: BrowserDriverOptions,
): Promise<BrowserDriver> {
  const module = (await import(pathToFileURL(plugin.resolvedPath).href)) as {
    default?: unknown;
    createDriver?: unknown;
  };

  const factory = pickFactory(module);
  if (!factory) {
    throw new TakoError(
      `browser 插件 ${plugin.specifier} 形状不对：需要 default export 一个工厂函数，` +
        '或导出 createDriver(options)。\n' +
        '  参考契约：src/types.ts 里的 BrowserDriverFactory',
      'DRIVER_INVALID',
      { specifier: plugin.specifier },
    );
  }

  // rootDir 始终是清单目录：插件据此写截图、读登录态，而不是插件自己的安装位置
  const driver = await factory(options);
  if (!driver || typeof driver.run !== 'function') {
    throw new TakoError(
      `browser 插件 ${plugin.specifier} 返回的驱动没有 run() 方法。`,
      'DRIVER_INVALID',
      { specifier: plugin.specifier },
    );
  }
  return driver;
}

function pickFactory(module: { default?: unknown; createDriver?: unknown }): BrowserDriverFactory | undefined {
  for (const candidate of [module.createDriver, module.default]) {
    if (typeof candidate === 'function') return candidate as BrowserDriverFactory;
    // 直接导出驱动对象时，包一层工厂，保证调用方拿到同样的形状
    if (candidate && typeof candidate === 'object' && typeof (candidate as BrowserDriver).run === 'function') {
      const driver = candidate as BrowserDriver;
      return () => driver;
    }
  }
  return undefined;
}
