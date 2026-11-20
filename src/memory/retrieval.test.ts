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
  RRF_K,
  VECTOR_POOL_FACTOR,
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

/**
 * 扫参用的可选旋钮（§6 第 1 条：改这些数必须附同一批查询的改前/改后位次，
 * 位次由 `scripts/akane-recall-eval.mjs` 离线采集）。
 *
 * 这一组断言分两类：一类钉「不传参时与加旋钮之前逐位一致」（现网默认路径），
 * 一类钉「这几个数本身是临时值」—— 想改就得同时改这条断言，那就是 §6 的机械抓手。
 */
describe('扫参旋钮（floor / 池宽 / rrfK / 片段数）', () => {
  /** 只在第 0 维放一个值，cosine() 是点积，于是分数就等于这个值 */
  const dim0 = (value: number, dims = 512): Float32Array => {
    const v = new Float32Array(dims);
    v[0] = value;
    return v;
  };

  it('floor 与 limit 都是对同一个有序序列的纯筛切（离线榜缓存能复用的前提）', () => {
    const rows = [row('s:1-1', '甲'), row('s:2-2', '乙'), row('s:3-3', '丙'), row('s:4-4', '丁'), row('s:5-5', '戊')];
    const vectors = [dim0(0.9), dim0(0.5), dim0(0.5), dim0(0.3), dim0(0.1)];
    const query = dim0(1);
    const full = vectorRanked(rows, vectors, query, rows.length, -Infinity);
    expect(full.map((item) => item.key)).toEqual(['s:1-1', 's:2-2', 's:3-3', 's:4-4', 's:5-5']);
    // 同分按 key 升序：s:2-2 与 s:3-3 都是 0.5，这一条把 tie-break 也钉住了
    expect(vectorRanked(rows, vectors, query, 2, -Infinity)).toEqual(full.slice(0, 2));
    expect(vectorRanked(rows, vectors, query, 99, 0.4)).toEqual(full.filter((item) => item.score >= 0.4));
    // 现网那一对默认值（floor=0.45、池宽=limit*3）必须也等于对完整榜做同样的筛切
    const limit = 6;
    expect(vectorRanked(rows, vectors, query, limit * VECTOR_POOL_FACTOR)).toEqual(
      full.filter((item) => item.score >= VECTOR_SIM_FLOOR).slice(0, limit * VECTOR_POOL_FACTOR),
    );
  });

  it('不传 k 时等于 RRF_K；传 k 才走传入值', () => {
    const lists = [{ source: 'literal' as const, keys: ['a', 'b'] }];
    expect(fuseRrf(lists)).toEqual(fuseRrf(lists, RRF_K));
    expect(fuseRrf(lists, 0)!.get('a')).toBeCloseTo(1, 12);
    expect(fuseRrf(lists, 0)!.get('b')).toBeCloseTo(1 / 2, 12);
  });

  it('k 只改融合名次、不改单档内部名次 —— 这条就是「改 k 必须带前后对比」的存在性证明', () => {
    const single = [{ source: 'literal' as const, keys: ['a', 'b', 'c'] }];
    for (const k of [0, 1, 60, 1000]) {
      expect([...fuseRrf(single, k).keys()]).toEqual(['a', 'b', 'c']);
    }
    // S 只在一档排第 1，D 在两档都排第 3：k 小则 S 赢，k 大则 D 赢
    const lists = [
      { source: 'literal' as const, keys: ['S', 'x', 'D'] },
      { source: 'vector' as const, keys: ['p', 'q', 'D'] },
    ];
    expect(fuseRrf(lists, 0)!.get('S')!).toBeGreaterThan(fuseRrf(lists, 0)!.get('D')!);
    expect(fuseRrf(lists, RRF_K)!.get('D')!).toBeGreaterThan(fuseRrf(lists, RRF_K)!.get('S')!);
  });

  it('不传 opts 时 selectCandidates 的融合分与加旋钮之前逐位一致', () => {
    const rows = [row('s:1-1', '甲'), row('s:2-2', '乙')];
    const lists = buildLists({
      literalKeys: ['s:1-1', 's:2-2'],
      vectorKeys: [{ key: 's:1-1', score: 0.7 }, { key: 's:2-2', score: 0.6 }],
    });
    const out = selectCandidates(rows, lists, 6);
    expect(out.map((candidate) => candidate.key)).toEqual(['s:1-1', 's:2-2']);
    expect(out[0]!.fused).toBeCloseTo(2 / 61, 15);
    expect(out[1]!.fused).toBeCloseTo(2 / 62, 15);
    expect(selectCandidates(rows, lists, 6, {})).toEqual(out);
    expect(out[0]!.fused).toBe(fuseRrf(lists)!.get('s:1-1'));
  });

  it('透传 rrfK 会改 selectCandidates 的输出顺序（评测口能扫到 k 的证据）', () => {
    // s:1-1 只在字面档排第 1；s:3-3 在两档都排第 3。k 小 → 单档榜首赢，k 大 → 双档在场赢。
    const rows = ['s:1-1', 's:2-2', 's:3-3', 's:4-4', 's:5-5'].map((key) => row(key, '文'));
    const lists = buildLists({
      literalKeys: ['s:1-1', 's:2-2', 's:3-3'],
      vectorKeys: [{ key: 's:4-4', score: 0.9 }, { key: 's:5-5', score: 0.8 }, { key: 's:3-3', score: 0.7 }],
    });
    expect(selectCandidates(rows, lists, 1, { rrfK: 0 })[0]!.key).toBe('s:1-1');
    expect(selectCandidates(rows, lists, 1, { rrfK: RRF_K })[0]!.key).toBe('s:3-3');
    expect(selectCandidates(rows, lists, 1)[0]!.key).toBe('s:3-3');
  });

  it('旋钮的默认形状与元数守卫（写成裸可选参会让上面那条隐私断言当场红）', () => {
    expect(fuseRrf.length).toBe(1);
    expect(selectCandidates.length).toBe(3);
  });

  it('RRF k 与池宽倍数同为临时值，改数必须同时改这条', () => {
    expect(RRF_K).toBe(60);
    expect(VECTOR_POOL_FACTOR).toBe(3);
  });
});
