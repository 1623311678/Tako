/**
 * 能力包（pack）：把一组能力以「纯数据 + 自包含脚本」的形式装进项目。
 *
 * 为什么要独立于核心：
 *   Tako 的全部主张是「能力是数据，不是代码」。如果加一条文生图或 PPT 能力
 *   需要改 src/，这个主张就自相矛盾了。所以官方能力与社区能力都走 pack：
 *   一个 tako.json 声明 + 若干脚本，装进来即用，核心一行不改。
 *
 * 装上之后项目是自包含的：脚本被拷进 <project>/tako-packs/<pack>/，
 * 清单里的路径同步改写，因此不依赖 npm 包的安装位置，可以直接提交到 git。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TakoError, loadManifest } from './manifest.js';

/** 装进项目后的目录名 */
export const INSTALLED_PACK_DIR = 'tako-packs';

export interface PackInfo {
  name: string;
  description: string;
  dir: string;
  verbs: string[];
  arms: string[];
}

export interface PackAddResult {
  pack: PackInfo;
  manifestFile: string;
  addedArms: string[];
  addedVerbs: string[];
  skipped: string[];
  installedScripts: string[];
}

/** npm 包内置的官方能力包目录 */
export function bundledPacksRoot(): string {
  return fileURLToPath(new URL('../packs', import.meta.url));
}

/** 列出某个来源下的全部能力包 */
export function listPacks(root: string = bundledPacksRoot()): PackInfo[] {
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .filter((entry) => statSync(path.join(root, entry)).isDirectory())
    .map((name) => {
      const dir = path.join(root, name);
      const manifestFile = path.join(dir, 'tako.json');
      if (!existsSync(manifestFile)) return null;

      const manifest = loadManifest(manifestFile);
      return {
        name,
        description: manifest.description || manifest.project,
        dir,
        verbs: manifest.verbs.map((verb) => verb.name),
        arms: manifest.arms.map((arm) => arm.name),
      } satisfies PackInfo;
    })
    .filter((pack): pack is PackInfo => pack !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolvePack(name: string, from?: string): PackInfo {
  const root = from ? path.resolve(from) : bundledPacksRoot();
  const pack = listPacks(root).find((item) => item.name === name);
  if (pack) return pack;

  const available = listPacks(root).map((item) => item.name);
  const hint = available.length > 0 ? `\n  可用的包：${available.join(', ')}` : '';
  throw new TakoError(
    `找不到能力包 "${name}"（在 ${root} 中查询）。${hint}\n  用 \`tako add --list\` 查看内置包。`,
    'PACK_NOT_FOUND',
  );
}

/**
 * 把能力包合并进目标清单，并拷贝脚本。
 *
 * 冲突策略：
 *   · arm 同名且 adapter 相同 → 视为同一个连接，跳过
 *   · arm 同名但 adapter 不同 → 冲突，需 --force 覆盖
 *   · verb 同名 → 冲突，需 --force 覆盖
 */
export function addPack(options: {
  manifestFile: string;
  packName: string;
  from?: string;
  force?: boolean;
}): PackAddResult {
  const { manifestFile, packName, from, force = false } = options;

  if (!existsSync(manifestFile)) {
    throw new TakoError(
      `当前目录没有 tako.json：${manifestFile}\n  先执行 \`tako init\`，或加 --file 指定清单。`,
      'MANIFEST_NOT_FOUND',
    );
  }

  const pack = resolvePack(packName, from);
  const target = readJson(manifestFile);
  const source = readJson(path.join(pack.dir, 'tako.json'));

  // 用局部变量持有数组，避免在 unknown 上做类型收窄的麻烦
  const arms: Record<string, unknown>[] = Array.isArray(target.arms)
    ? (target.arms as Record<string, unknown>[])
    : [];
  const verbs: Record<string, unknown>[] = Array.isArray(target.verbs)
    ? (target.verbs as Record<string, unknown>[])
    : [];
  target.arms = arms;
  target.verbs = verbs;

  const result: PackAddResult = {
    pack,
    manifestFile,
    addedArms: [],
    addedVerbs: [],
    skipped: [],
    installedScripts: [],
  };
  const conflicts: string[] = [];

  // ── 合并连接 ──
  for (const arm of asArray(source.arms)) {
    const name = asString(arm.name);
    if (!name) continue;

    const existing = arms.find((item) => asString(item.name) === name);
    if (!existing) {
      arms.push(arm);
      result.addedArms.push(name);
      continue;
    }
    if (asString(existing.adapter) === asString(arm.adapter)) {
      result.skipped.push(`arm ${name}（已存在且适配器一致）`);
      continue;
    }
    if (!force) {
      conflicts.push(`arm ${name} 已存在但 adapter 不同（现为 ${asString(existing.adapter)}）`);
      continue;
    }
    Object.assign(existing, arm);
    result.skipped.push(`arm ${name}（已覆盖）`);
  }

  // ── 合并动词，同时改写脚本路径指向安装后的位置 ──
  const scriptPrefix = `./${INSTALLED_PACK_DIR}/${pack.name}/`;

  for (const verb of asArray(source.verbs)) {
    const name = asString(verb.name);
    if (!name) continue;

    const existingIndex = verbs.findIndex((item) => asString(item.name) === name);
    const migrated = relocateScripts(verb, scriptPrefix);

    if (existingIndex === -1) {
      verbs.push(migrated);
      result.addedVerbs.push(name);
      continue;
    }
    if (!force) {
      conflicts.push(`verb ${name} 已存在`);
      continue;
    }
    verbs[existingIndex] = migrated;
    result.skipped.push(`verb ${name}（已覆盖）`);
  }

  if (conflicts.length > 0) {
    throw new TakoError(
      `与现有清单冲突（${conflicts.length} 项）：\n  · ${conflicts.join('\n  · ')}\n` +
        '  换个名字，或加 --force 覆盖。',
      'PACK_CONFLICT',
      { conflicts },
    );
  }

  // ── 拷贝脚本：让项目自包含，不依赖 npm 包位置 ──
  const installDir = path.join(path.dirname(manifestFile), INSTALLED_PACK_DIR, pack.name);
  const scriptsSource = path.join(pack.dir, 'scripts');

  if (existsSync(scriptsSource)) {
    if (existsSync(installDir) && !force) {
      result.skipped.push(`tako-packs/${pack.name}/ 已存在，未覆盖脚本`);
    } else {
      mkdirSync(installDir, { recursive: true });
      cpSync(scriptsSource, path.join(installDir, 'scripts'), { recursive: true, force: true });
      result.installedScripts = listFilesRecursive(path.join(installDir, 'scripts'));
    }
  }

  writeFileSync(manifestFile, `${JSON.stringify(target, null, 2)}\n`, 'utf8');
  return result;
}

/** 把 ./scripts/x.mjs 改写为 ./tako-packs/<pack>/scripts/x.mjs */
function relocateScripts(verb: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const action = verb.action;
  if (!action || typeof action !== 'object') return verb;

  const script = (action as Record<string, unknown>).script;
  if (typeof script !== 'string' || !script.startsWith('./')) return verb;

  return {
    ...verb,
    action: { ...(action as Record<string, unknown>), script: prefix + script.slice(2) },
  };
}

/* ── 小工具 ─────────────────────────────────────────────── */

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new TakoError(
      `${path.basename(file)} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      'MANIFEST_INVALID_JSON',
    );
  }
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(path.relative(path.dirname(path.dirname(dir)), full));
  }
  return out;
}
