/**
 * 到达间隔统计 —— 「静默窗口该设多长」的唯一数据来源
 *
 * 插桩只记观测值（见 `src/middleware/arrival-probe.ts`），把观测变成数字这一步
 * 单独放在这里，是为了让口径可被单元测试钉住：spec §3.5 US-31 要求口径固定死，
 * 免得每次重算换一个数字。
 *
 * 这些数字唯一的作用是给 `quietWindowMs` 定默认值。窗口加在她**每一次**回复的延迟上，
 * 所以取的是分位数而不是均值 —— 均值会被少数长间隔拉高，那正是我们不想要的代价。
 */

/** 一条插桩记录（与落盘的 JSONL 同形） */
export interface ProbeRecord {
  /** 本地接收毫秒（单调时钟不可跨进程存盘，这里用 Date.now，只用于求差） */
  t: number;
  /** 桶键散列（scope:targetId:senderId 的 sha256 前 8 位） */
  k: string;
  /** 消息 id */
  m: string;
  /** 该条自身是否命中唤醒（显式 @ 或唤醒词）；未知时缺省 */
  w?: 0 | 1;
}

/** 相邻两条超过这个间隔就不算「同一句话的分片」，spec US-31 定死 120s */
export const MAX_PAIR_GAP_MS = 120_000;

/** 低于这个样本量只许报「继续攒」，不许拿数字填默认值，spec US-31 定死 300 对 */
export const MIN_PAIRS_FOR_DECISION = 300;

export interface ArrivalSummary {
  /** 进入分布的相邻对数 */
  pairs: number;
  p50: number;
  p90: number;
  p95: number;
  /** 同刻重复投递的对数（B2 取证要看的就是这个，不进分布） */
  duplicates: number;
  /** 样本量是否够定默认值 */
  enough: boolean;
}

/** 分桶后的相邻间隔（含 0，0 单独计入 duplicates） */
export function adjacentGaps(records: ProbeRecord[], onlyWokeBuckets: boolean = false): number[] {
  const byBucket = new Map<string, ProbeRecord[]>();
  for (const r of records) {
    const list = byBucket.get(r.k);
    if (list) list.push(r);
    else byBucket.set(r.k, [r]);
  }

  const gaps: number[] = [];
  for (const list of byBucket.values()) {
    // 「这个桶里有没有人喊过她」是桶级筛选：只看被唤醒的那条会把续句整批丢掉
    if (onlyWokeBuckets && !list.some((r) => r.w === 1)) continue;
    list.sort((a, b) => a.t - b.t);
    for (let i = 1; i < list.length; i++) {
      gaps.push(list[i]!.t - list[i - 1]!.t);
    }
  }
  return gaps.sort((a, b) => a - b);
}

/** 最近秩分位（小样本下比插值分位诚实：给出的永远是真实观测值） */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1]!;
}

export function summarizeArrivals(records: ProbeRecord[], onlyWokeBuckets: boolean = false): ArrivalSummary {
  const all = adjacentGaps(records, onlyWokeBuckets);
  const duplicates = all.filter((g) => g <= 0).length;
  const gaps = all.filter((g) => g > 0 && g < MAX_PAIR_GAP_MS);
  return {
    pairs: gaps.length,
    p50: percentile(gaps, 0.5),
    p90: percentile(gaps, 0.9),
    p95: percentile(gaps, 0.95),
    duplicates,
    enough: gaps.length >= MIN_PAIRS_FOR_DECISION,
  };
}
