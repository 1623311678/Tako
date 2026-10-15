/**
 * 能力仓库（capability repo）—— 让能力可以「发出去」和「拿回来」。
 *
 * 为什么仓库用 git，而不是自建服务：
 *   能力就是文件（清单声明 + 自包含脚本），它天然适合被版本控制、被 review、被 fork。
 *   再搭一个中心服务只会重新发明权限、审核、版本历史和投票——而且多一个要运维的东西。
 *   git 已经全都有了，`--to` 直接写仓库地址即可。
 *
 * 仓库形状：
 *   index.json          索引：包名 → 版本 / 动词 / 摘要 / 发布者 / 审核状态
 *   <pack>/tako.json    包清单（只含被推送的 verbs，以及它们依赖的 arms）
 *   <pack>/meta.json    元数据（版本、摘要、审核状态）
 *   <pack>/scripts/…    script 动词用到的脚本，按原相对路径搬过来
 *
 * 审核：push 默认写入 `review.status = "pending"`；`--approve --reviewer <人>`
 * 才写成 approved。人审这一步不藏在代码里，就写在文件里、可被 git 追溯。
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { TakoError, loadManifest } from './manifest.js';
import type { Arm, Manifest, Verb } from './types.js';

const run = promisify(execFile);

/** 克隆到本地的仓库缓存：换台机器/换个工作目录也不必重新克隆 */
export const REPO_CACHE_DIR = path.join(os.homedir(), '.tako', 'repos');

export type ReviewStatus = 'pending' | 'approved';

export interface CapabilityPackMeta {
  name: string;
  version: string;
  description: string;
  publisher: string;
  publishedAt: string;
  source: string;
  verbs: string[];
  arms: string[];
  /** 内容摘要，用于判断「是否真的变了」 */
  digest: string;
  review: { status: ReviewStatus; reviewer?: string; at?: string };
}

export interface RepoIndex {
  formatVersion: 1;
  packs: Record<string, CapabilityPackMeta>;
}

/* ── 来源解析：本地目录 or git 地址 ─────────────────────── */

export interface ResolvedRepo {
  /** 可直接读写的本地目录 */
  dir: string;
  kind: 'dir' | 'git';
  /** 原始的 --to 取值，用于写进 meta.source */
  source: string;
}

export function looksLikeGit(source: string): boolean {
  return (
    /^(https?|ssh|git|file):\/\//.test(source) ||
    /^git@/.test(source) ||
    source.endsWith('.git')
  );
}

export async function resolveRepo(source: string, log: (line: string) => void): Promise<ResolvedRepo> {
  if (!looksLikeGit(source)) {
    const dir = path.resolve(source);
    mkdirSync(dir, { recursive: true });
    return { dir, kind: 'dir', source };
  }

  const dir = path.join(REPO_CACHE_DIR, createHash('sha1').update(source).digest('hex').slice(0, 16));
  if (existsSync(path.join(dir, '.git'))) {
    log(`更新仓库缓存：${dir}`);
    await git(['pull', '--ff-only'], dir);
  } else {
    mkdirSync(REPO_CACHE_DIR, { recursive: true });
    log(`克隆能力仓库：${source}`);
    await git(['clone', '--depth', '1', source, dir], REPO_CACHE_DIR);
  }
  return { dir, kind: 'git', source };
}

/** 有 git 就提交并推送：能力仓库的价值一半在「可追溯」 */
export async function commitRepo(
  repo: ResolvedRepo,
  message: string,
  log: (line: string) => void,
): Promise<{ committed: boolean; pushed: boolean; note?: string }> {
  if (!existsSync(path.join(repo.dir, '.git'))) {
    return { committed: false, pushed: false, note: '目录不是 git 仓库，未提交（内容已写入磁盘）' };
  }

  await git(['add', '-A'], repo.dir);
  const status = await git(['status', '--porcelain'], repo.dir);
  if (!status.trim()) return { committed: false, pushed: false, note: '没有变化，无需提交' };

  await git(['commit', '-m', message], repo.dir);
  log(`已提交：${message}`);

  try {
    await git(['push'], repo.dir);
    return { committed: true, pushed: true };
  } catch (error) {
    return {
      committed: true,
      pushed: false,
      note: `已提交但推送失败（本地提交保留）：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await run('git', [...args], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const message =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: string }).stderr ?? '')
        : String(error);
    throw new TakoError(`git ${args.join(' ')} 失败：${message.trim() || '未知错误'}`, 'TAKO_ERROR');
  }
}

/* ── 索引 ───────────────────────────────────────────────── */

export function readIndex(repoDir: string): RepoIndex {
  const file = path.join(repoDir, 'index.json');
  if (!existsSync(file)) return { formatVersion: 1, packs: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as RepoIndex;
    if (!parsed.packs) parsed.packs = {};
    return parsed;
  } catch (error) {
    throw new TakoError(
      `${file} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      'TAKO_ERROR',
    );
  }
}

/* ── 打包 ───────────────────────────────────────────────── */

export interface PushOptions {
  manifestFile: string;
  repo: ResolvedRepo;
  /** 只推送这些动词；不传则全部 */
  verbNames?: readonly string[];
  packName?: string;
  version?: string;
  description?: string;
  publisher?: string;
  approve?: boolean;
  reviewer?: string;
  /** 只算结果，不写盘也不拷脚本 */
  dryRun?: boolean;
  log: (line: string) => void;
}

export interface PushResult {
  pack: CapabilityPackMeta;
  dir: string;
  /** 相对上一次发布内容是否真的变了 */
  changed: boolean;
  previousVersion?: string;
  scripts: string[];
}

export function buildPack(options: PushOptions): PushResult {
  const { manifestFile, repo, log, dryRun = false } = options;
  const manifest = loadManifest(manifestFile);

  const selected = selectVerbs(manifest, options.verbNames);
  if (selected.length === 0) {
    throw new TakoError('没有可推送的动词（用 tako ls 看看有哪些）', 'USAGE');
  }

  const name = sanitizePackName(options.packName ?? manifest.project);
  const packDir = path.join(repo.dir, name);
  const index = readIndex(repo.dir);
  const previous = index.packs[name];

  const version = options.version ?? previous?.version ?? '0.1.0';
  const usedArms = unique(selected.map((verb) => verb.arm));
  const arms = usedArms
    .map((armName) => manifest.armByName.get(armName))
    .filter((arm): arm is Arm => Boolean(arm));

  // script 动词的脚本要一起搬走，包必须自包含（与 tako add 的约定一致）
  const scripts = copyScripts({ manifest, verbs: selected, packDir, dryRun });
  const packManifest = {
    tako: 1,
    project: name,
    description: options.description ?? `从 ${manifest.project} 发布的 ${selected.length} 个能力`,
    arms,
    verbs: selected.map((verb) => relocateVerb(verb, scripts)),
  };

  const digest = digestOf(packManifest, manifest.dir, scripts);
  const changed = previous?.digest !== digest;
  const reviewer = options.reviewer ?? options.publisher ?? currentUser();

  const meta: CapabilityPackMeta = {
    name,
    version,
    description: packManifest.description,
    publisher: options.publisher ?? currentUser(),
    publishedAt: new Date().toISOString(),
    source: repo.source,
    verbs: selected.map((verb) => verb.name),
    arms: usedArms,
    digest,
    review: options.approve
      ? { status: 'approved', reviewer, at: new Date().toISOString() }
      : (previous?.review.status === 'approved' && !changed
          ? previous.review
          : { status: 'pending' }),
  };

  if (!dryRun) {
    mkdirSync(packDir, { recursive: true });
    writeFileSync(path.join(packDir, 'tako.json'), `${JSON.stringify(packManifest, null, 2)}\n`, 'utf8');
    writeFileSync(path.join(packDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    index.packs[name] = meta;
    writeFileSync(path.join(repo.dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }

  log(`${dryRun ? '[dry-run] ' : ''}已打包 ${name}@${version}：${selected.length} 个动词`);
  return { pack: meta, dir: packDir, changed, previousVersion: previous?.version, scripts: [...scripts.values()] };
}

function selectVerbs(manifest: Manifest, names?: readonly string[]): Verb[] {
  if (!names || names.length === 0) return [...manifest.verbs];
  return names.map((name) => {
    const verb = manifest.verbByName.get(name);
    if (!verb) {
      throw new TakoError(`清单里没有动词 "${name}"（用 tako ls 查看）`, 'VERB_NOT_FOUND');
    }
    return verb;
  });
}

/** 把 verb 引用的 script 拷进包内，并把路径改写成包内相对路径 */
function copyScripts(input: {
  manifest: Manifest;
  verbs: readonly Verb[];
  packDir: string;
  dryRun: boolean;
}): Map<string, string> {
  const { manifest, verbs, packDir, dryRun } = input;
  const map = new Map<string, string>();

  for (const verb of verbs) {
    const script = verb.action.script;
    if (!script) continue;

    const from = path.resolve(manifest.dir, script);
    if (!from.startsWith(manifest.dir)) {
      throw new TakoError(`脚本越出清单目录，拒绝打包：${script}`, 'SCRIPT_ESCAPE');
    }
    if (!existsSync(from)) {
      throw new TakoError(`脚本不存在，无法打包：${from}`, 'SCRIPT_NOT_FOUND');
    }

    const relative = path.relative(manifest.dir, from);
    if (!dryRun) {
      const to = path.join(packDir, relative);
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(from, to, { force: true });
    }
    map.set(script, `./${relative.split(path.sep).join('/')}`);
  }

  return map;
}

function relocateVerb(verb: Verb, scripts: ReadonlyMap<string, string>): Verb {
  const next = scripts.get(verb.action.script ?? '');
  if (!next) return verb;
  return { ...verb, action: { ...verb.action, script: next } };
}

/**
 * 摘要只覆盖内容，不含时间戳 —— 否则每次跑摘要都变，changed 就失去意义了。
 * 脚本从源目录读而不是从包目录读，这样 --dry-run 也能算出同样的摘要。
 */
function digestOf(
  packManifest: unknown,
  sourceDir: string,
  scripts: ReadonlyMap<string, string>,
): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(packManifest));

  for (const [, relative] of [...scripts].sort()) {
    const file = path.resolve(sourceDir, relative.replace(/^\.\//, ''));
    if (existsSync(file)) hash.update(`${relative}:${readFileSync(file, 'utf8')}`);
  }
  return hash.digest('hex').slice(0, 16);
}

/* ── 看仓库里有什么 ─────────────────────────────────────── */

export interface RepoListing {
  repoDir: string;
  packs: CapabilityPackMeta[];
  /** 目录里存在但不是本工具发布的包 */
  foreign: string[];
}

export function listRepo(repoDir: string): RepoListing {
  const index = readIndex(repoDir);
  const packs: CapabilityPackMeta[] = [];

  for (const [name, meta] of Object.entries(index.packs)) {
    if (existsSync(path.join(repoDir, name, 'tako.json'))) packs.push(meta);
  }
  packs.sort((a, b) => a.name.localeCompare(b.name));

  const foreign = existsSync(repoDir)
    ? readdirSync(repoDir)
        .filter((entry) => statSync(path.join(repoDir, entry)).isDirectory())
        .filter((entry) => !entry.startsWith('.'))
        .filter((entry) => !index.packs[entry])
        .filter((entry) => !existsSync(path.join(repoDir, entry, 'tako.json')))
    : [];

  return { repoDir, packs, foreign };
}

/* ── 小工具 ─────────────────────────────────────────────── */

function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sanitizePackName(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'tako-pack';
}
