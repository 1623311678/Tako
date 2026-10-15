/**
 * @hun-dun/tako-adapter-browser —— tako 的官方浏览器驱动插件（Playwright 实现）。
 *
 * 为什么它是独立包、不含在 tako 核心里：
 *   tako 核心理念是「运行时依赖为 0」，而浏览器自动化必然要带一个驱动（Playwright 约
 *   几十 MB + 浏览器二进制）。把驱动下沉到插件，核心就能保持零依赖、秒启动；
 *   不用浏览器的人完全不需要付出这个体积代价。
 *
 * 它做两件事：
 *   run()     执行声明式步骤（打开页面 → 操作 → 取值）
 *   capture() 录制页面上真实的 XHR/fetch 请求，供 `tako capture` 反推出 http 动词
 *
 * 插件契约见 tako 的 src/types.ts（BrowserDriver）。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

/** 静态资源不是「能力」，抓包时直接丢掉 */
const STATIC_PATTERN = /\.[a-z0-9]{2,5}(\?|$)/i;

/** 只有这两类才是「接口调用」；文档/脚本/图片不是能力 */
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch']);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CAPTURE_MS = 30_000;

async function createDriver({ rootDir, log = () => {} }) {
  const options = { rootDir, log };
  return {
    run: (input) => run(input, options),
    capture: (input) => capture(input, options),
  };
}

export default createDriver;
export { createDriver };

/* ── 执行步骤 ───────────────────────────────────────────── */

async function run(input, { rootDir, log }) {
  const { chromium } = await loadPlaywright();
  const driverOptions = input.driverOptions ?? {};
  const timeout = input.timeoutMs || DEFAULT_TIMEOUT_MS;

  const browser = await launch(chromium, driverOptions, log);
  const context = await browser.newContext({
    viewport: driverOptions.viewport ?? { width: 1440, height: 900 },
    storageState: storageStateOf(driverOptions, rootDir),
  });
  context.setDefaultTimeout(timeout);

  const page = await context.newPage();
  const outputs = {};

  try {
    for (const [index, step] of input.steps.entries()) {
      log(`step ${index + 1}/${input.steps.length}: ${describeStep(step)}`);
      await applyStep(page, step, outputs, rootDir);
    }

    if (driverOptions.persistState) {
      await context.storageState({ path: statePath(rootDir) });
      log(`登录态已保存到 ${statePath(rootDir)}`);
    }

    return { url: page.url(), outputs };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function applyStep(page, step, outputs, rootDir) {
  if ('goto' in step) {
    await page.goto(step.goto, { waitUntil: step.waitUntil ?? 'load' });
    return;
  }
  if ('click' in step) {
    await page.click(step.click);
    return;
  }
  if ('fill' in step) {
    await page.fill(step.fill, step.value);
    return;
  }
  if ('press' in step) {
    await page.press(step.press, step.key);
    return;
  }
  if ('waitFor' in step) {
    await page.waitForSelector(step.waitFor, { timeout: step.timeoutMs });
    return;
  }
  if ('wait' in step) {
    await page.waitForTimeout(step.wait);
    return;
  }
  if ('texts' in step) {
    outputs[step.as ?? 'texts'] = await page.$$eval(step.texts, (nodes) =>
      nodes.map((node) => (node.textContent ?? '').trim()),
    );
    return;
  }
  if ('text' in step) {
    const node = await page.waitForSelector(step.text);
    outputs[step.as] = ((await node?.textContent()) ?? '').trim();
    return;
  }
  if ('attribute' in step) {
    const node = await page.waitForSelector(step.attribute);
    outputs[step.as] = await node?.getAttribute(step.name);
    return;
  }
  if ('count' in step) {
    outputs[step.as] = await page.$$eval(step.count, (nodes) => nodes.length);
    return;
  }
  if ('eval' in step) {
    outputs[step.as ?? 'result'] = await page.evaluate(step.eval);
    return;
  }
  if ('screenshot' in step) {
    const target = path.resolve(rootDir, step.screenshot);
    await page.screenshot({ path: target, fullPage: true });
    outputs.screenshot = path.relative(rootDir, target);
    return;
  }

  throw new Error(`无法识别的步骤：${JSON.stringify(step)}`);
}

/* ── 录制请求 ───────────────────────────────────────────── */

async function capture(input, { rootDir, log }) {
  const { chromium } = await loadPlaywright();
  const durationMs = input.durationMs ?? DEFAULT_CAPTURE_MS;

  const browser = await launch(chromium, {}, log);
  const context = await browser.newContext();
  const page = await context.newPage();

  const requests = [];
  const pending = new Map();

  page.on('request', (request) => {
    const url = request.url();
    if (!/^https?:/i.test(url)) return;
    // 只要接口：页面自身、脚本、图片都不是「可调用的能力」
    if (!API_RESOURCE_TYPES.has(request.resourceType())) return;
    if (STATIC_PATTERN.test(url)) return;

    const headers = request.headers();
    const contentType = headers['content-type'] ?? '';
    const raw = request.postData();
    let body;
    if (raw) {
      try {
        body = contentType.includes('json') ? JSON.parse(raw) : raw;
      } catch {
        body = raw;
      }
    }

    const entry = {
      method: request.method(),
      url,
      headers,
      resourceType: request.resourceType(),
      ...(body === undefined ? {} : { body }),
    };
    requests.push(entry);
    pending.set(request, entry);
  });

  page.on('response', async (response) => {
    const entry = pending.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    const contentType = response.headers()['content-type'] ?? '';
    if (!contentType.includes('json')) return;
    try {
      entry.response = await response.json();
    } catch {
      // 响应体读不出来就算了，status 已经够用
    }
  });

  try {
    if (input.startUrl) await page.goto(input.startUrl, { waitUntil: 'load' });
    log(`开始录制，${Math.round(durationMs / 1000)}s 后在页面上操作（Ctrl+C 可提前结束）`);
    await page.waitForTimeout(durationMs);
    return { url: page.url(), requests: dedupe(requests) };
  } finally {
    await context.close();
    await browser.close();
  }
}

/** 同一 URL+方法 反复请求只留一条，并保留最后一次的响应 */
function dedupe(requests) {
  const byKey = new Map();
  for (const entry of requests) {
    const key = `${entry.method} ${entry.url}`;
    const previous = byKey.get(key);
    byKey.set(key, previous ? { ...previous, ...entry } : entry);
  }
  return [...byKey.values()];
}

/* ── Playwright 加载与启动 ──────────────────────────────── */

/**
 * 从插件自身位置解析 playwright。做成动态 import 是为了：
 * 没装 playwright 时给出可操作的提示，而不是让整个 CLI 加载失败。
 */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    throw new Error(
      '需要 playwright 才能使用 browser 驱动。\n' +
        '  安装：npm i -D playwright && npx playwright install chromium\n' +
        '  或复用本机 Chrome：装完 playwright 即可（无需下载浏览器）\n' +
        `  原始错误：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 默认优先用本机 Chrome（省去下载浏览器），不可用再退回 Playwright 自带 chromium */
async function launch(chromium, driverOptions, log) {
  const headless = driverOptions.headless !== false;
  const base = { headless, slowMo: driverOptions.slowMo };

  if (driverOptions.channel) {
    log(`启动浏览器：channel=${driverOptions.channel} headless=${headless}`);
    return chromium.launch({ ...base, channel: driverOptions.channel });
  }

  try {
    return await chromium.launch({ ...base, channel: 'chrome' });
  } catch {
    log('本机 Chrome 不可用，退回 Playwright 自带 chromium');
    return chromium.launch(base);
  }
}

/* ── 登录态复用的落点 ───────────────────────────────────── */

function statePath(rootDir) {
  return path.join(rootDir, '.tako', 'browser-state.json');
}

function storageStateOf(driverOptions, rootDir) {
  if (!driverOptions.persistState) return undefined;
  const file = statePath(rootDir);
  return existsSync(file) ? file : undefined;
}

function describeStep(step) {
  const [key, value] = Object.entries(step)[0] ?? ['?', ''];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `${key}: ${text.slice(0, 80)}`;
}
