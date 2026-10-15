/**
 * 列出当前仓库最近的提交。
 *
 * script 适配器的约定：
 *   · default export 一个函数，收到 { params, verb, root, log, readFile }
 *   · 路径基于 root（清单所在目录）解析，不要用 process.cwd()
 *   · 返回任意可 JSON 序列化的结果，tako run 会负责打印
 *   · 抛出的错误会变成 CLI 的失败输出与退出码 1
 */

import { execFileSync } from 'node:child_process';

/** 用不可见字符分隔字段，避免提交标题里的 | 干扰解析 */
const SEP = '\u0001';

export default function gitRecent({ params, root, log }) {
  const count = Number(params.count ?? 10);
  const format = ['%h', '%an', '%ad', '%s'].join(SEP);
  const args = ['log', `-n${count}`, `--pretty=format:${format}`, '--date=short'];

  if (params.author) args.push(`--author=${params.author}`);

  let raw;
  try {
    raw = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`${root} 不是 git 仓库，或环境里没有 git：${detail}`);
  }

  const commits = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, ...subject] = line.split(SEP);
      return { hash, author, date, subject: subject.join(SEP) };
    });

  log(`git log -n${count} → ${commits.length} 条提交`);

  return {
    repo: root,
    count: commits.length,
    commits,
  };
}
