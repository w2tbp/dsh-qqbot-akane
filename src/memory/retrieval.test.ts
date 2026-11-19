/**
 * hybrid 召回的打分与融合（§9 测试 2 / 11 的正本）
 *
 * 这两个函数错了不会报错，只会「答得很像但答错」—— 那是要防的那一类错。
 * 所以断言的是：弱相似进不了榜、字面档是 AND 不是 OR、两档分数不相加。
 */
import { describe, expect, it } from 'vitest';
import type { ChunkRow } from './index-store.ts';
import {
  buildLists,
  cosine,
  matchesLiteral,
  queryTokens,
  selectCandidates,
  vectorRanked,
  fuseRrf,
  DEFAULT_FRAGMENT_LIMIT,
  MAX_FRAGMENT_CHARS,
  MAX_RETURN_CHARS,
  VECTOR_SIM_FLOOR,
} from './retrieval.ts';

function row(key: string, text: string, time = 0, role: 'peer' | 'akane' = 'peer'): ChunkRow {
  return {
    key,
    sessionId: key.split(':')[0]!,
    peer: 'c2c:oA',
    seqStart: 1,
    seqEnd: 1,
    time,
    role,
    hasMedia: false,
    textLen: text.length,
    text,
  };
}

function vector(oneAt: number, dims = 512): Float32Array {
  const v = new Float32Array(dims);
  v[oneAt] = 1;
  return v;
}

describe('queryTokens', () => {
  it('中文按 2 字窗口、拉丁词按整词，全部小写去重', () => {
    expect(queryTokens('猫粮')).toEqual(['猫粮']);
    expect(queryTokens('QQ 群')).toEqual(['qq', '群']);
    expect(queryTokens('上次那个 Cat粮 的问题')).toContain('cat');
    expect(new Set(queryTokens('猫粮猫粮')).size).toBe(queryTokens('猫粮猫粮').length);
  });

  it('纯标点/空白 → 空词元（调用方据此判「没法查」而不是全表命中）', () => {
    expect(queryTokens(' ！！！ ')).toEqual([]);
    expect(queryTokens('a 1')).toEqual([]); // 单字符拉丁与单位数不算词元
  });
});

describe('字面档：逐词 AND（§9 测试 2）', () => {
  it('查「猫 加班」只回同一篇里两者都命中的片段', () => {
    const tokens = queryTokens('猫 加班');
    expect(matchesLiteral('今天加班，家里的猫把杯子碰掉了', tokens)).toBe(true);
    expect(matchesLiteral('今天加班到十点', tokens)).toBe(false);
    expect(matchesLiteral('我家猫好胖', tokens)).toBe(false);
  });

  it('词元为空一律不命中', () => {
    expect(matchesLiteral('任何文本', [])).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(matchesLiteral('My Cat is here', queryTokens('cat'))).toBe(true);
  });

  it('绝不调 FTS —— unicode61 把整段中文切成 1 个 token，FTS 对中文 0 命中', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./retrieval.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toContain('sqlite');
    expect(source).not.toMatch(/prepare\s*\(/);
    expect(source).not.toMatch(/\bMATCH\s*\(/);
    expect(source).not.toMatch(/CREATE\s+(?:VIRTUAL\s+)?TABLE/i);
  });
});

describe('cosine / vectorRanked', () => {
  it('归一化向量的点积即余弦', () => {
    expect(cosine(vector(0), vector(0))).toBeCloseTo(1, 6);
    expect(cosine(vector(0), vector(1))).toBe(0);
  });

  it('低于阈值的直接不进榜（§9 测试 11：弱相似不算命中）', () => {
    const rows = [row('s1:1-1', '甲'), row('s1:2-2', '乙')];
    const lists = vectorRanked(rows, [vector(1), vector(0)], vector(0), 6);
    expect(lists.map((item) => item.key)).toEqual(['s1:2-2']); // 正交那条分数为零，连榜位都不给
  });

  it('缺向量的行跳过，不臆造分数', () => {
    const rows = [row('s1:1-1', '甲'), row('s1:2-2', '乙')];
    expect(vectorRanked(rows, [undefined, vector(0)], vector(0), 6).map((i) => i.key)).toEqual(['s1:2-2']);
  });

  it('同分按键稳定排序，榜长受 limit', () => {
    const rows = ['a', 'b', 'c'].map((_, i) => row(`s${i}:1-1`, '文'));
    const ranked = vectorRanked(rows, rows.map(() => vector(0)), vector(0), 2);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((item) => item.score > VECTOR_SIM_FLOOR)).toBe(true);
  });

  it('阈值是临时值：改动必须带同一批查询的前后对比（这条钉住当前数字）', () => {
    expect(VECTOR_SIM_FLOOR).toBe(0.45);
  });
});

describe('fuseRrf：两档排名融合，分数不相加', () => {
  it('k=60 的倒数融合', () => {
    const fused = fuseRrf([{ source: 'literal', keys: ['a', 'b'] }, { source: 'vector', keys: ['b'] }]);
    expect(fused.get('a')).toBeCloseTo(1 / 61, 12);
    expect(fused.get('b')).toBeCloseTo(1 / 62 + 1 / 61, 12);
  });

  it('空列表不贡献分数 —— 服务不可达时不需要额外分支（§9 测试 10 的根据）', () => {
    const only = fuseRrf([{ source: 'literal', keys: ['a'] }, { source: 'vector', keys: [] }]);
    expect(only.size).toBe(1);
    expect(only.get('a')).toBeCloseTo(1 / 61, 12);
  });

  it('buildLists 把余弦分数带进列表，字面档永远在第一位', () => {
    const lists = buildLists({ literalKeys: ['a'], vectorKeys: [{ key: 'a', score: 0.8 }] });
    expect(lists.map((l) => l.source)).toEqual(['literal', 'vector']);
    expect(lists[1]!.scores?.get('a')).toBe(0.8);
  });
});

describe('selectCandidates', () => {
  it('融合分优先，同分近的在前（她说「上次」时近期命中更符合直觉）', () => {
    const rows = [row('s:1-1', '甲', 100), row('s:2-2', '乙', 200)];
    const out = selectCandidates(rows, [{ source: 'literal', keys: ['s:1-1', 's:2-2'] }], 6);
    expect(out.map((c) => c.key)).toEqual(['s:1-1', 's:2-2']);
    const tie = selectCandidates(rows, [{ source: 'literal', keys: ['s:1-1'] }, { source: 'vector', keys: ['s:2-2'] }], 6);
    expect(tie.map((c) => c.key)).toEqual(['s:2-2', 's:1-1']); // 名次相同 → 时间近的在前
  });

  it('标注命中来源，答错了能定位是哪一档捞错', () => {
    const rows = [row('s:1-1', '甲'), row('s:2-2', '乙')];
    const out = selectCandidates(rows, buildLists({
      literalKeys: ['s:1-1'],
      vectorKeys: [{ key: 's:1-1', score: 0.7 }, { key: 's:2-2', score: 0.6 }],
    }), 6);
    expect(out[0]!.sources).toEqual(['literal', 'vector']);
    expect(out[0]!.vectorScore).toBe(0.7);
    expect(out[1]!.sources).toEqual(['vector']);
  });

  it('榜单引用了不存在的键就丢弃，不臆造片段', () => {
    const out = selectCandidates([row('s:1-1', '甲')], [{ source: 'literal', keys: ['ghost:9-9'] }], 6);
    expect(out).toEqual([]);
  });

  it('limit 生效', () => {
    const rows = ['a', 'b', 'c'].map((k) => row(`s:1-1-${k}`, '文'));
    const out = selectCandidates(rows, [{ source: 'literal', keys: rows.map((r) => r.key) }], 2);
    expect(out).toHaveLength(2);
  });

  it('这一层不做任何隐私判断：签名里没有 cwd / 目录参数', () => {
    expect(selectCandidates.length).toBe(3);
    expect(DEFAULT_FRAGMENT_LIMIT).toBe(6);
    expect(MAX_RETURN_CHARS).toBe(3000);
    expect(MAX_FRAGMENT_CHARS).toBe(600);
  });
});
