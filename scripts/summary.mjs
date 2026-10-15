/**
 * 示例 script 能力：对内置数据做统计，返回 Top N。
 *
 * 约定：script 适配器的入口是 default export，收到一个上下文对象：
 *   { params, verb, log, readFile }
 * 返回什么，`tako run` 就打印什么 —— 不需要自己处理输出格式。
 */

const DATASETS = {
  traffic: [
    { label: '/feed', hits: 128430 },
    { label: '/profile', hits: 98211 },
    { label: '/search', hits: 74190 },
    { label: '/settings', hits: 20455 },
    { label: '/about', hits: 3120 },
  ],
  errors: [
    { label: 'HTTP 500', hits: 412 },
    { label: 'HTTP 401', hits: 288 },
    { label: 'HTTP 429', hits: 133 },
    { label: 'HTTP 404', hits: 97 },
    { label: 'ECONNRESET', hits: 21 },
  ],
};

export default function summary({ params, log }) {
  const rows = DATASETS[params.dataset];
  log(`数据集 ${params.dataset}，共 ${rows.length} 条，取前 ${params.top} 条`);

  const ranked = [...rows].sort((a, b) => b.hits - a.hits);
  const total = ranked.reduce((sum, row) => sum + row.hits, 0);

  return {
    dataset: params.dataset,
    total,
    top: ranked.slice(0, params.top).map((row, index) => ({
      rank: index + 1,
      label: row.label,
      hits: row.hits,
      share: `${((row.hits / total) * 100).toFixed(1)}%`,
    })),
  };
}
