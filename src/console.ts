/**
 * console —— 三端同源的第三端，终于落地了。
 *
 * 为什么不做成 Vite + React 单页应用：
 *   那需要 node_modules、构建产物、版本对齐，而控制台的受众是「已经装了 tako 的人」——
 *   让ta 为了点一个按钮先跑一次 npm install，是把选择的代价放错了地方。
 *   所以这里用 node:http 直接提供一份自包含页面（零依赖、零构建），
 *   `tako console` 打开即用。
 *
 * 而真正需要复用的逻辑一行都没重写：页面数据来自 index.ts 里的公共 API
 * （toFormSpec / toCliUsage / toToolSpecs / toAgentContext），
 * 和 CLI 用的是同一组函数 —— 这才是「三端同源」可验证的地方。
 *
 * 安全姿态：只绑 127.0.0.1。destructive 级动词必须请求里显式带 yes，
 * 由页面上的二次确认勾选框产生，控制台自己不会替用户确认。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  TakoError,
  loadManifest,
  toCliUsage,
  toFormSpec,
  toToolSpecs,
} from './manifest.js';
import { toAgentContext } from './context.js';
import { execute } from './run.js';
import type { Manifest, ParameterValues } from './types.js';

export interface ConsoleOptions {
  manifestFile: string;
  port?: number;
  /** 默认 127.0.0.1：这是本地工具，不该被局域网访问 */
  host?: string;
  log: (line: string) => void;
}

export interface ConsoleHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

const DEFAULT_PORT = 7788;
const MAX_BODY = 1024 * 1024;

export async function startConsole(options: ConsoleOptions): Promise<ConsoleHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_PORT;

  const server = createServer((request, response) => {
    handle(request, response, options).catch((error: unknown) => {
      sendJson(response, 500, {
        ok: false,
        error: { code: 'CONSOLE_ERROR', message: error instanceof Error ? error.message : String(error) },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actual = (server.address() as { port: number }).port;
  const url = `http://${host}:${actual}/`;
  options.log(`控制台已启动：${url}`);

  return { port: actual, url, close: () => closeServer(server) };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ConsoleOptions,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (url.pathname === '/' || url.pathname === '/index.html') {
    sendHtml(response, renderConsolePage(options.manifestFile));
    return;
  }

  if (url.pathname === '/api/manifest') {
    sendJson(response, 200, buildManifestPayload(options.manifestFile));
    return;
  }

  if (url.pathname === '/api/run' && request.method === 'POST') {
    const body = await readJsonBody(request);
    sendJson(response, 200, await runVerb(options.manifestFile, body));
    return;
  }

  sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未知路径 ${url.pathname}` } });
}

/* ── 数据：全部复用公共 API ─────────────────────────────── */

function buildManifestPayload(manifestFile: string): unknown {
  const manifest = loadManifest(manifestFile);

  return {
    project: manifest.project,
    file: manifest.file,
    armCount: manifest.arms.length,
    verbCount: manifest.verbs.length,
    arms: manifest.arms.map((arm) => ({
      name: arm.name,
      adapter: arm.adapter,
      baseUrl: arm.baseUrl,
      description: arm.description,
    })),
    verbs: manifest.verbs.map((verb) => ({
      name: verb.name,
      arm: verb.arm,
      risk: verb.risk,
      idempotent: verb.idempotent,
      description: verb.description,
      aiExample: verb.aiExample,
      cli: toCliUsage(verb),
      form: toFormSpec(verb),
      // 复用同一组投影函数：控制台看到的工具定义与 tako tools 输出完全一致
      tool: toToolSpecs({ ...manifest, verbs: [verb] })[0],
    })),
    context: toAgentContext(manifest, { env: {} }),
  };
}

interface RunRequest {
  verb?: unknown;
  params?: unknown;
  dryRun?: unknown;
  yes?: unknown;
}

async function runVerb(manifestFile: string, body: RunRequest): Promise<unknown> {
  const manifest = loadManifest(manifestFile);
  const verbName = typeof body.verb === 'string' ? body.verb : undefined;
  if (!verbName) {
    return fail('USAGE', '缺少 verb');
  }

  const verb = manifest.verbByName.get(verbName);
  if (!verb) {
    return fail('VERB_NOT_FOUND', `清单里没有动词 "${verbName}"`);
  }

  // 危险操作的双重确认由用户勾选产生；控制台不替用户确认
  if (verb.risk === 'destructive' && body.yes !== true && body.dryRun !== true) {
    return fail(
      'USAGE',
      `${verb.name} 是 destructive 级操作，不可逆。勾选「我确认」后再执行，或先用 dry-run 预览。`,
    );
  }

  const params = (body.params && typeof body.params === 'object' ? body.params : {}) as ParameterValues;
  const cleaned = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== '' && value !== null && value !== undefined),
  );

  try {
    const result = await execute(manifest, verb, cleaned, { dryRun: body.dryRun === true });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof TakoError) return fail(error.code, error.message);
    return fail('TAKO_ERROR', error instanceof Error ? error.message : String(error));
  }
}

function fail(code: string, message: string): unknown {
  return { ok: false, error: { code, message } };
}

/* ── HTTP 小工具 ────────────────────────────────────────── */

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<RunRequest> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new TakoError('请求体过大', 'USAGE');
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as RunRequest;
  } catch {
    throw new TakoError('请求体不是合法 JSON', 'USAGE');
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/* ── 页面 ───────────────────────────────────────────────── */

function renderConsolePage(manifestFile: string): string {
  const escaped = manifestFile.replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>tako console</title>
<style>
  :root{--bg:#0e1116;--panel:#161b22;--line:#232b36;--fg:#e6edf3;--dim:#8b949e;
        --accent:#58a6ff;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
  header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
  header h1{margin:0;font-size:16px;letter-spacing:.5px}
  header .meta{color:var(--dim);font-size:12px;font-family:var(--mono)}
  .wrap{display:grid;grid-template-columns:300px 1fr;min-height:calc(100vh - 53px)}
  aside{border-right:1px solid var(--line);padding:12px;overflow:auto;max-height:calc(100vh - 53px)}
  aside input{width:100%;padding:7px 10px;margin-bottom:10px;background:var(--panel);color:var(--fg);
    border:1px solid var(--line);border-radius:6px;font-size:13px}
  .verb{display:block;width:100%;text-align:left;padding:8px 10px;margin-bottom:4px;background:transparent;
    border:1px solid transparent;border-radius:6px;color:var(--fg);cursor:pointer;font-size:13px}
  .verb:hover{background:var(--panel)}
  .verb.on{background:var(--panel);border-color:var(--accent)}
  .verb .n{font-family:var(--mono);font-size:12.5px}
  .verb .d{color:var(--dim);font-size:11.5px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  main{padding:18px 22px;overflow:auto;max-height:calc(100vh - 53px)}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
  .card h2{margin:0 0 4px;font-size:15px;font-family:var(--mono)}
  .card .sub{color:var(--dim);font-size:12.5px;margin-bottom:12px}
  .tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
  .tag{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim);font-family:var(--mono)}
  .tag.read{color:var(--ok);border-color:#1c3a24}.tag.write{color:var(--warn);border-color:#3d3216}
  .tag.destructive{color:var(--bad);border-color:#4a1f1f}
  .tabs{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}
  .tab{padding:5px 12px;border:1px solid var(--line);background:transparent;color:var(--dim);
    border-radius:6px;cursor:pointer;font-size:12.5px}
  .tab.on{color:var(--fg);border-color:var(--accent);background:rgba(88,166,255,.08)}
  .field{margin-bottom:12px}
  .field label{display:block;font-size:12.5px;margin-bottom:5px}
  .field .req{color:var(--bad);margin-left:4px}
  .field .hint{color:var(--dim);font-size:11.5px;margin-top:4px;font-family:var(--mono)}
  .field input,.field select,.field textarea{width:100%;padding:7px 10px;background:#0d1117;color:var(--fg);
    border:1px solid var(--line);border-radius:6px;font-family:var(--mono);font-size:12.5px}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:4px}
  button.act{padding:8px 16px;border-radius:6px;border:1px solid var(--line);background:var(--panel);
    color:var(--fg);cursor:pointer;font-size:13px}
  button.act.primary{background:var(--accent);border-color:var(--accent);color:#08121f;font-weight:600}
  button.act:disabled{opacity:.45;cursor:not-allowed}
  label.check{display:flex;gap:6px;align-items:center;color:var(--dim);font-size:12.5px}
  pre{margin:0;padding:12px;background:#0d1117;border:1px solid var(--line);border-radius:8px;
    overflow:auto;font-family:var(--mono);font-size:12.5px;white-space:pre-wrap;word-break:break-word;max-height:420px}
  .status{margin:10px 0 6px;font-size:13px}
  .ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.dim{color:var(--dim)}
  .empty{color:var(--dim);padding:40px 0;text-align:center}
</style></head><body>
<header>
  <h1>tako <span class="dim">console</span></h1>
  <span class="meta" id="meta">加载中…</span>
</header>
<div class="wrap">
  <aside>
    <input id="q" placeholder="搜索动词 / 说明…" autocomplete="off">
    <div id="list"></div>
  </aside>
  <main><div class="empty" id="empty">← 左边选一个动词</div><div id="detail" hidden></div></main>
</div>
<script>
const MANIFEST_FILE = ${JSON.stringify(escaped)};
let data = null, current = null, tab = 'form';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

init();

async function init() {
  const res = await fetch('/api/manifest');
  data = await res.json();
  $('meta').textContent = data.project + ' · ' + data.verbCount + ' 个动词 · ' + data.armCount + ' 条连接 · ' + data.file;
  renderList('');
  $('q').addEventListener('input', (e) => renderList(e.target.value));
}

function renderList(keyword) {
  const kw = keyword.trim().toLowerCase();
  const verbs = data.verbs.filter((v) =>
    !kw || v.name.toLowerCase().includes(kw) || (v.description || '').toLowerCase().includes(kw)
     || (v.aiExample || '').toLowerCase().includes(kw));
  $('list').innerHTML = verbs.map((v) =>
    '<button class="verb' + (current && current.name === v.name ? ' on' : '') + '" data-name="' + esc(v.name) + '">' +
      '<span class="n">' + esc(v.name) + '</span>' +
      '<span class="d">' + esc(v.description || v.aiExample || '') + '</span>' +
    '</button>').join('') || '<div class="dim" style="padding:8px">没有匹配的动词</div>';
  $('q').dispatchEvent; // no-op
  document.querySelectorAll('.verb').forEach((el) => el.addEventListener('click', () => selectVerb(el.dataset.name)));
}

function selectVerb(name) {
  current = data.verbs.find((v) => v.name === name);
  document.querySelectorAll('.verb').forEach((el) => el.classList.toggle('on', el.dataset.name === name));
  $('empty').hidden = true;
  $('detail').hidden = false;
  tab = 'form';
  renderDetail();
}

function renderDetail() {
  const v = current;
  $('detail').innerHTML =
    '<div class="card">' +
      '<h2>' + esc(v.name) + '</h2>' +
      '<div class="sub">' + esc(v.description) + '</div>' +
      '<div class="tags">' +
        '<span class="tag ' + v.risk + '">' + v.risk + '</span>' +
        '<span class="tag">arm: ' + esc(v.arm) + '</span>' +
        '<span class="tag">' + (v.idempotent ? '幂等' : '非幂等') + '</span>' +
        (v.aiExample ? '<span class="tag">aiExample</span>' : '<span class="tag" style="color:#d29922">缺 aiExample</span>') +
      '</div>' +
      (v.aiExample ? '<div class="dim" style="font-size:12.5px;margin-bottom:12px">Agent 何时调用 · ' + esc(v.aiExample) + '</div>' : '') +
      '<div class="tabs">' +
        tabBtn('form', '表单') + tabBtn('cli', 'CLI') + tabBtn('tool', 'Agent 工具定义') + tabBtn('context', 'Agent 上下文') +
      '</div>' +
      '<div id="tabbody"></div>' +
    '</div>';
  document.querySelectorAll('.tab').forEach((el) => el.addEventListener('click', () => { tab = el.dataset.tab; renderDetail(); }));
  renderTab();
}

const tabBtn = (id, label) => '<button class="tab' + (tab === id ? ' on' : '') + '" data-tab="' + id + '">' + label + '</button>';

function renderTab() {
  const v = current, body = $('tabbody');
  if (tab === 'cli') { body.innerHTML = '<pre>' + esc(v.cli) + '</pre>'; return; }
  if (tab === 'tool') { body.innerHTML = '<pre>' + esc(JSON.stringify(v.tool, null, 2)) + '</pre>'; return; }
  if (tab === 'context') { body.innerHTML = '<pre>' + esc(data.context) + '</pre>'; return; }

  if (!v.form.fields.length) {
    body.innerHTML = '<div class="dim" style="margin-bottom:12px">这个动词没有参数。</div>' +
      runControls(v) + '<div id="result"></div>';
    wireRun();
    return;
  }

  body.innerHTML = v.form.fields.map((f) => {
    const label = '<label>' + esc(f.label || f.name) + (f.required ? '<span class="req">*</span>' : '') + '</label>';
    const hint = '<div class="hint">' + esc('--' + f.name + ' · ' + (f.placeholder || '')) + '</div>';
    let control;
    if (f.widget === 'switch') {
      control = '<select data-name="' + esc(f.name) + '" data-type="boolean"><option value="">（不传）</option><option value="true">true</option><option value="false">false</option></select>';
    } else if (f.widget === 'select') {
      const opts = (f.options || []).map((o) => '<option value="' + esc(o) + '">' + esc(o) + '</option>').join('');
      control = '<select data-name="' + esc(f.name) + '"><option value="">（不传）</option>' + opts + '</select>';
    } else if (f.widget === 'code') {
      control = '<textarea rows="4" data-name="' + esc(f.name) + '" data-type="json" placeholder="' + esc(f.placeholder) + '"></textarea>';
    } else {
      control = '<input data-name="' + esc(f.name) + '" data-type="' + (f.widget === 'number' ? 'number' : 'string') +
        '"' + (f.masked ? ' type="password"' : '') + ' placeholder="' + esc(f.placeholder) + '" value="' + (f.defaultValue !== undefined ? esc(f.defaultValue) : '') + '">';
    }
    return '<div class="field">' + label + control + hint + '</div>';
  }).join('') + runControls(v) + '<div id="result"></div>';
  wireRun();
}

function runControls(v) {
  return '<div class="row">' +
    '<button class="act" id="dry">dry-run 预览</button>' +
    '<button class="act primary" id="go">执行</button>' +
    (v.risk === 'destructive' ? '<label class="check"><input type="checkbox" id="yes"> 我确认，这是不可逆操作</label>' : '') +
  '</div>';
}

function collect() {
  const params = {};
  document.querySelectorAll('[data-name]').forEach((el) => {
    let value = el.value;
    if (value === '') return;
    if (el.dataset.type === 'number') value = Number(value);
    else if (el.dataset.type === 'boolean') value = value === 'true';
    params[el.dataset.name] = value;
  });
  return params;
}

function wireRun() {
  const v = current;
  const call = async (dryRun) => {
    const box = $('result');
    box.innerHTML = '<div class="status dim">执行中…</div>';
    const res = await fetch('/api/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb: v.name, params: collect(), dryRun,
        yes: Boolean($('yes') && $('yes').checked) }),
    });
    const payload = await res.json();
    if (!payload.ok) {
      box.innerHTML = '<div class="status bad">✗ ' + esc(payload.error.code) + '</div><pre>' + esc(payload.error.message) + '</pre>';
      return;
    }
    const r = payload.result;
    box.innerHTML = '<div class="status ok">✓ ' + esc(v.name) +
      (r.dryRun ? ' <span class="warn">dry-run（未产生副作用）</span>' : '') +
      (r.durationMs !== undefined ? ' <span class="dim">' + r.durationMs + 'ms</span>' : '') +
      (r.status ? ' <span class="dim">HTTP ' + r.status + '</span>' : '') + '</div>' +
      '<pre>' + esc(JSON.stringify(r.dryRun ? r.plan : r.data, null, 2)) + '</pre>';
  };
  $('dry').addEventListener('click', () => call(true));
  $('go').addEventListener('click', () => call(false));
}
</script>
</body></html>`;
}
