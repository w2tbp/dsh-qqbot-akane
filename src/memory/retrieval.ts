/**
 * hybrid 召回的打分与融合（§2 取链的纯函数部分）
 *
 * 两条档：
 * - **字面档**：按 chunk 文本做**逐词 AND**（实测 unicode61 分词器把整段中文切成 1 个
 *   token、FTS5 对中文 0 命中，所以绝不走 FTS）。一条 chunk 必须同时含全部词元才算命中。
 * - **语义档**：查询向量与**同 peer** 全量 chunk 向量暴力余弦，低于阈值的直接不进榜。
 *
 * 融合用 RRF（排名倒数融合，k=60），**不把两种分数直接加权相加** —— 那是 §2 点名的
 * 「假可比性」。字面分数是集合关系、余弦分数是相似度，两者不可加。
 *
 * 阈值 `VECTOR_SIM_FLOOR` 是**临时值**（§6 第 2 条）：磁盘上没有召回质量数值，定它需要的
 * 「≥20 条真实问法 + 期望命中」还没有。参照物只有 §3 的 8 句冒烟（相关句对 0.75 上下、
 * 无关句对 0.22–0.36），0.45 只是把冒烟里「最不像无关对」的那一档拦在外面，
 * **不是校准值** —— P2 有那批查询分布后按同一批前后对比重定。
 */
import type { ChunkRole } from './chunking.ts';
import type { ChunkRow } from './index-store.ts';

/** 命中来源标注（§6 第 3 条：答错了要能定位是字面档捞错还是语义档捞错） */
export type HitSource = 'literal' | 'vector';

export interface RecallCandidate {
  key: string;
  sessionId: string;
  seqStart: number;
  seqEnd: number;
  time: number;
  role: ChunkRole;
  /** T2 里存的折叠正文（已洗过群历史脚手架，但仍可能带图片痕迹标记） */
  text: string;
  literalRank?: number;
  vectorRank?: number;
  /** 该条的余弦值，只有语义档命中才有 */
  vectorScore?: number;
  /** RRF 融合分 */
  fused: number;
  sources: HitSource[];
}

/** RRF 常数：一期照 §2 用 60，改动必须带同一批查询的前后对比 */
export const RRF_K = 60;

/** 语义档绝对下限（临时，见文件头） */
export const VECTOR_SIM_FLOOR = 0.45;

/** 一次召回最多返几条片段（§4 限额，临时值） */
export const DEFAULT_FRAGMENT_LIMIT = 6;

/** 语义档进融合前的池宽 = 片段数 × 本倍数（临时值；现网原样是内联的 `limit * 3`） */
export const VECTOR_POOL_FACTOR = 3;

/** 返回体硬顶（§4：单位是字符，不折算 token） */
export const MAX_RETURN_CHARS = 3000;

/** 单片段硬顶（§4） */
export const MAX_FRAGMENT_CHARS = 600;

/**
 * 查询 → 词元。
 *
 * 中文按 2 字窗口切（「猫粮」这种 2 字词最稳），单字查询就留单字；拉丁词与数字
 * 按整词（≥2 字符）保留。全部小写、去重。没有词形还原、没有停用词 ——
 * 一期只做到「字面包含」这一层语义。
 */
export function queryTokens(query: string): string[] {
  const lower = query.toLowerCase();
  const tokens = new Set<string>();

  for (const run of lower.match(/[a-z0-9]+/g) ?? []) {
    if (run.length >= 2) tokens.add(run);
  }

  for (const run of lower.match(/[㐀-䶿一-鿿豈-﫿]+/g) ?? []) {
    const chars = [...run];
    if (chars.length === 1) {
      tokens.add(chars[0]!);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.add(chars[i]! + chars[i + 1]!);
  }

  return [...tokens];
}

/** 逐词 AND：chunk 必须含全部词元 */
export function matchesLiteral(text: string, needles: readonly string[]): boolean {
  if (needles.length === 0) return false;
  const lower = text.toLowerCase();
  return needles.every((needle) => lower.includes(needle));
}

/** 定长向量的点积；两侧都已归一化，所以点积即余弦 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * 语义档：对同 peer 的全量 chunk 向量暴力扫一遍（§4 规模账：2–4MB 量级下够了）。
 *
 * 低于阈值的**不进榜** —— 榜位本身就不该给弱相似，这样「弱相似不算命中」不依赖
 * 任何下游判断（§9 测试 11）。
 */
export function vectorRanked(
  rows: readonly ChunkRow[],
  vectors: readonly (Float32Array | undefined)[],
  query: Float32Array,
  limit: number,
  floor = VECTOR_SIM_FLOOR,
): Array<{ key: string; score: number }> {
  const scored: Array<{ key: string; score: number }> = [];
  for (let i = 0; i < rows.length; i += 1) {
    const vector = vectors[i];
    if (vector === undefined) continue;
    const score = cosine(query, vector);
    if (score < floor) continue;
    scored.push({ key: rows[i]!.key, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1));
  return scored.slice(0, limit);
}

export interface RankedList {
  source: HitSource;
  keys: readonly string[];
  scores?: ReadonlyMap<string, number>;
}

/**
 * RRF 融合。空列表不贡献分数，所以「服务不可达 → 只剩字面档」不需要额外分支
 * （§9 测试 10），也不许在这里掺任何按档位的加权常量。
 */
export function fuseRrf(lists: readonly RankedList[], k = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.keys.forEach((key, index) => {
      fused.set(key, (fused.get(key) ?? 0) + 1 / (k + index + 1));
    });
  }
  return fused;
}

/** 扫参用的可选覆盖项，只给离线评测口（`scripts/akane-recall-eval.mjs`）；现网调用点一个都不传 */
export interface SelectOptions {
  /** RRF k */
  rrfK?: number;
}

/**
 * 两档 → 最终候选。排序只看融合分，同分时近的在前（她说「上次」时近期命中更符合直觉）。
 *
 * 这一层不做任何隐私判断 —— peer 过滤在喂进来之前完成，函数签名里也没有 cwd/目录参数。
 * 第 4 参**必须带默认值**：`retrieval.test.ts` 钉着 `selectCandidates.length === 3`，钉的就是上面
 * 那句「签名里没有目录参数」；写成裸可选参 `opts?:` 会让元数变 4，那条守卫当场红。
 */
export function selectCandidates(
  rows: readonly ChunkRow[],
  lists: readonly RankedList[],
  limit: number,
  opts: SelectOptions = {},
): RecallCandidate[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const ranks = new Map<string, { literal?: number; vector?: number; score?: number }>();
  for (const list of lists) {
    list.keys.forEach((key, index) => {
      const entry: { literal?: number; vector?: number; score?: number } = ranks.get(key) ?? {};
      if (list.source === 'literal') entry.literal = index + 1;
      else {
        entry.vector = index + 1;
        entry.score = list.scores?.get(key);
      }
      ranks.set(key, entry);
    });
  }

  const fused = fuseRrf(lists, opts.rrfK ?? RRF_K);
  const out: RecallCandidate[] = [];
  for (const [key, score] of fused) {
    const row = byKey.get(key);
    if (row === undefined) continue; // 榜单引用了不在输入 rows 里的键：丢弃而不臆造
    const entry = ranks.get(key) ?? {};
    const sources: HitSource[] = [];
    if (entry.literal !== undefined) sources.push('literal');
    if (entry.vector !== undefined) sources.push('vector');
    out.push({
      key,
      sessionId: row.sessionId,
      seqStart: row.seqStart,
      seqEnd: row.seqEnd,
      time: row.time,
      role: row.role,
      text: row.text,
      literalRank: entry.literal,
      vectorRank: entry.vector,
      vectorScore: entry.score,
      fused: score,
      sources,
    });
  }
  out.sort((a, b) => b.fused - a.fused || b.time - a.time || (a.key < b.key ? -1 : 1));
  return out.slice(0, limit);
}

/** 把两档结果拼成 selectCandidates 要的输入，同时把余弦分数带下去 */
export function buildLists(input: {
  literalKeys: readonly string[];
  vectorKeys: ReadonlyArray<{ key: string; score: number }>;
}): RankedList[] {
  const lists: RankedList[] = [{ source: 'literal', keys: [...input.literalKeys] }];
  if (input.vectorKeys.length > 0) {
    lists.push({
      source: 'vector',
      keys: input.vectorKeys.map((item) => item.key),
      scores: new Map(input.vectorKeys.map((item) => [item.key, item.score])),
    });
  }
  return lists;
}
