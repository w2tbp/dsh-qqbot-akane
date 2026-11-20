import { describe, expect, it } from 'vitest';
import {
  MIN_TURNS_FOR_DECISION,
  TIER_ORDER,
  rowsByTier,
  summarizeStickerTurns,
  type StickerTurnRecord,
} from './sticker-turn-stats.ts';

function rec(over: Partial<StickerTurnRecord> = {}): StickerTurnRecord {
  return { t: 1_700_000_000_000, s: 'g', i: 0, k: 0, l: 'normal', ...over };
}

const pct = (list: readonly StickerTurnRecord[]) => summarizeStickerTurns(list);

describe('每轮配图统计口径', () => {
  it('分子只认 k —— present 了非梗图的图（i>0 k=0）不算配了梗图', () => {
    const rows = pct([rec({ i: 1, k: 0 }), rec({ i: 1, k: 1 })]).group;
    expect(rows[0]!.turns).toBe(2);
    expect(rows[0]!.withGallery).toBe(1);
    expect(rows[0]!.ratio).toBeCloseTo(0.5);
  });

  it('群与私聊各算各的，档位相同的记录不互相稀释', () => {
    const s = pct([rec({ l: 'active', k: 1 }), rec({ l: 'active', s: 'c', k: 0 })]);
    expect(s.group).toHaveLength(1);
    expect(s.group[0]!.ratio).toBe(1);
    expect(s.c2c).toHaveLength(1);
    expect(s.c2c[0]!.ratio).toBe(0);
  });

  it('表按 TIER_ORDER 固定顺序出，与记录写进盘里的先后无关', () => {
    const rows = pct([
      rec({ l: 'active' }),
      rec({ l: 'quiet' }),
      rec({ l: 'off' }),
      rec({ l: 'normal' }),
    ]).group;
    expect(rows.map((r) => r.level)).toEqual([...TIER_ORDER]);
  });

  it('某一档零记录 ⇒ 不占一行，也不凭空造一个 0%', () => {
    const rows = pct([rec({ l: 'quiet' }), rec({ l: 'quiet', k: 1 })]).group;
    expect(rows.map((r) => r.level)).toEqual(['quiet']);
    expect(rows[0]!.ratio).toBe(0.5);
  });

  it('那一档全都没配图 ⇒ 有行且 ratio 为 0（off 档的正确形状，不能被当成没数据）', () => {
    const rows = pct([rec({ l: 'off' }), rec({ l: 'off' })]).group;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.withGallery).toBe(0);
    expect(rows[0]!.ratio).toBe(0);
    expect(rows[0]!.galleryImages).toBe(0);
  });

  it('galleryImages 是 Σk 不是轮数 —— 占比不动而绝对数动，两个都得看得见', () => {
    const rows = pct([rec({ k: 3 }), rec({ k: 2 }), rec({ k: 0 })]).group;
    expect(rows[0]!.turns).toBe(3);
    expect(rows[0]!.galleryImages).toBe(5);
  });

  it('样本量闸门：到 MIN_TURNS_FOR_DECISION 才许比较，没到就只出数不出结论', () => {
    const under = pct(Array.from({ length: MIN_TURNS_FOR_DECISION - 1 }, () => rec({ k: 1 }))).group;
    expect(under[0]!.enough).toBe(false);
    const at = pct(Array.from({ length: MIN_TURNS_FOR_DECISION }, () => rec({ k: 1 }))).group;
    expect(at[0]!.enough).toBe(true);
    // 闸门不改变数字本身，只改变它能不能被拿去定档
    expect(at[0]!.ratio).toBe(1);
  });

  it('rowsByTier 是分组原语，scope 不掺进来（脚本要单看某一栏时直接用）', () => {
    expect(rowsByTier([])).toEqual([]);
    expect(rowsByTier([rec({ s: 'c' }), rec({ s: 'g' })])[0]!.turns).toBe(2);
  });
});
