/**
 * 扫描源码里的 TODO / FIXME / HACK / XXX。
 *
 * 说明：这是「研发基础能力」里最典型的只读分析类脚本 ——
 * 不联网、不改文件，输入是目录、输出是结构化统计，非常适合给 AI 调用。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', 'vendor', 'target', '.venv', '__pycache__', '.idea', '.vscode',
]);

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.rb', '.php', '.cs',
  '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm',
  '.sh', '.sql', '.proto',
]);

/**
 * 只认「注释里的」标记：要求前面有注释前缀。
 * 否则 `{ TODO: 0 }` 这种对象键、`/(TODO|FIXME)/` 这种正则都会被误报，
 * 而这些误报正好会出现在本文件自身。
 */
const MARKER = /(?:\/\/|#|--|\/\*|<!--|\*|;)\s*(TODO|FIXME|HACK|XXX)\b:?\s*(.*)$/i;
const MAX_BYTES = 512 * 1024;

export default function todoScan({ params, root, log }) {
  const target = path.resolve(root, String(params.path ?? '.'));
  const top = Math.max(1, Number(params.top ?? 5));

  const files = [];
  collect(target, files);
  log(`扫描 ${target}，命中 ${files.length} 个源码文件`);

  const byKind = { TODO: 0, FIXME: 0, HACK: 0, XXX: 0 };
  const perFile = [];
  let total = 0;

  for (const file of files) {
    const hits = scanFile(file);
    if (hits.length === 0) continue;

    total += hits.length;
    for (const hit of hits) byKind[hit.kind] += 1;

    perFile.push({
      file: path.relative(root, file) || path.basename(file),
      count: hits.length,
      items: hits.slice(0, 5),
    });
  }

  perFile.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));

  return {
    scannedRoot: path.relative(root, target) || '.',
    filesScanned: files.length,
    total,
    byKind,
    filesWithMarkers: perFile.length,
    top: perFile.slice(0, top),
  };
}

function scanFile(file) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const hits = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = MARKER.exec(line);
    if (!match) continue;

    const note = (match[2] ?? '').trim();
    hits.push({
      line: index + 1,
      kind: (match[1] ?? 'TODO').toUpperCase(),
      text: (note || line.trim()).slice(0, 120),
    });
  }
  return hits;
}

function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);

    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      collect(full, out);
      continue;
    }
    if (!stats.isFile()) continue;
    if (stats.size > MAX_BYTES) continue;
    if (!TEXT_EXT.has(path.extname(entry).toLowerCase())) continue;

    out.push(full);
  }
}
