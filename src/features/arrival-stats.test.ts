import { describe, expect, it } from 'vitest';
import {
  adjacentGaps,
  MAX_PAIR_GAP_MS,
  MIN_PAIRS_FOR_DECISION,
  percentile,
  summarizeArrivals,
  type ProbeRecord,
} from './arrival-stats.ts';

/** 造记录：只关心 t / k / w 三个字段 */
function rec(t: number, k: string, w?: 0 | 1): ProbeRecord {
  return { t, k, m: `MSG-${t}-${k}`, ...(w === undefined ? {} : { w }) };
}

describe('相邻间隔（US-31 口径）', () => {
  it('同桶相邻两条才计，跨桶不配对', () => {
    const gaps = adjacentGaps([rec(0, 'A'), rec(100, 'A'), rec(50, 'B')]);
    expect(gaps).toEqual([100]);
  });

  it('乱序到达也按时间排好再求差', () => {
    const gaps = adjacentGaps([rec(300, 'A'), rec(0, 'A'), rec(100, 'A')]);
    expect(gaps).toEqual([100, 200]);
  });

  it('只统计被唤醒的桶（onlyWoke）—— 没人喊她的桶不能拿来定窗口', () => {
    const records = [rec(0, 'A', 0), rec(100, 'A', 0), rec(0, 'B', 0), rec(250, 'B', 1)];
    expect(adjacentGaps(records, false)).toEqual([100, 250]);
    expect(adjacentGaps(records, true)).toEqual([250]);
  });
});

describe('分位数', () => {
  it('最近秩：给真实观测值而不是插值', () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(percentile(sorted, 0.5)).toBe(30);
    expect(percentile(sorted, 0.9)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(50);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('汇总（US-31 的验收形态）', () => {
  it('间隔 ≥ 120s 视为另一段话，不进分布', () => {
    const summary = summarizeArrivals([rec(0, 'A'), rec(1_000, 'A'), rec(1_000 + MAX_PAIR_GAP_MS, 'A')]);
    expect(summary.pairs).toBe(1);
    expect(summary.p95).toBe(1_000);
  });

  it('同刻重复投递单独计数，不污染分位数（B2 的观测面）', () => {
    const summary = summarizeArrivals([rec(0, 'A'), rec(0, 'A'), rec(800, 'A')]);
    expect(summary.duplicates).toBe(1);
    expect(summary.pairs).toBe(1);
    expect(summary.p50).toBe(800);
  });

  it('样本不足 300 对 → enough=false（不许先拿一个数字填默认值）', () => {
    const records: ProbeRecord[] = [rec(0, 'A')];
    for (let i = 1; i <= 100; i++) records.push(rec(i * 200, 'A'));
    const summary = summarizeArrivals(records);
    expect(summary.pairs).toBe(100);
    expect(summary.enough).toBe(false);
  });

  it('够 300 对才允许出数', () => {
    const records: ProbeRecord[] = [rec(0, 'A')];
    for (let i = 1; i <= MIN_PAIRS_FOR_DECISION; i++) records.push(rec(i * 200, 'A'));
    expect(summarizeArrivals(records).enough).toBe(true);
  });
});
