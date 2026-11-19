/**
 * chunk 切分：脚手架剥离与「一个想法一条」的边界（§9 测试形状的地基）
 *
 * 这里出错不会有任何报错 —— 只是索引悄悄建在污染文本上（把群历史样板当她的话），
 * 所以每条都用现网的真实渲染形状断言，而不是用理想化的输入。
 */
import { describe, expect, it } from 'vitest';
import { chunkEvents, extractCurrentMessage, type ChunkDraft, type TranscriptEvent } from './chunking.ts';

const SCAFFOLD = [
  '[Chat history begins]',
  '  └ Image: /home/anon/.dsh-qqbot-akane/media/abc_1700000000000_x.png',
  '  小明 (o777abc): 这猫粮多少钱',
  '[Chat history ends]',
  '[Current message] 猫粮太贵了，一包要两百多',
].join('\n');

function event(seq: number, time: number, role: TranscriptEvent['role'], rawText: string): TranscriptEvent {
  return { seq, time, role, rawText };
}

/** 只要 chunk、不看丢弃明细的用例走这个；丢弃本身另有专门用例 */
function chunksOf(
  events: readonly TranscriptEvent[],
  quietWindowMs: number,
  options?: { strictGap?: boolean },
): ChunkDraft[] {
  return chunkEvents(events, quietWindowMs, options).chunks;
}

describe('extractCurrentMessage', () => {
  it('只取 [Current message] 之后那段', () => {
    expect(extractCurrentMessage(SCAFFOLD)).toBe('猫粮太贵了，一包要两百多');
  });

  it('有历史标记却没有当前标记 → 空串（宁可丢弃也不把样板入库）', () => {
    const polluted = ['[Chat history begins]', '  小明 (o777abc): 这猫粮多少钱', '[Chat history ends]'].join('\n');
    expect(extractCurrentMessage(polluted)).toBe('');
  });

  it('没有脚手架的原样返回（私聊简单形状）', () => {
    expect(extractCurrentMessage('这猫粮多少钱')).toBe('这猫粮多少钱');
  });

  it('绝不把主机路径留在结果里', () => {
    expect(extractCurrentMessage(SCAFFOLD)).not.toContain('/home/');
    expect(extractCurrentMessage(SCAFFOLD)).not.toContain('└ Image:');
  });
});

describe('chunkEvents', () => {
  it('同人、间隔 ≤ 窗口 → 合成一条（一个想法一条）', () => {
    const chunks = chunksOf([
      event(1, 0, 'peer', '猫粮太贵了'),
      event(2, 5000, 'peer', '一包要两百多'),
    ], 12000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('猫粮太贵了\n一包要两百多');
    expect(chunks[0]!.seqStart).toBe(1);
    expect(chunks[0]!.seqEnd).toBe(2);
  });

  it('间隔 > 窗口 → 切成两条', () => {
    const chunks = chunksOf([
      event(1, 0, 'peer', '猫粮太贵了'),
      event(2, 12001, 'peer', '今天加班到十点'),
    ], 12000);
    expect(chunks.map((c) => c.text)).toEqual(['猫粮太贵了', '今天加班到十点']);
  });

  it('不同角色绝不合并（出处要分得清谁说的）', () => {
    const chunks = chunksOf([
      event(1, 0, 'peer', '这猫粮多少钱'),
      event(2, 1000, 'akane', '两千多一包'),
      event(3, 2000, 'peer', '太贵了吧'),
    ], 12000);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.role)).toEqual(['peer', 'akane', 'peer']);
  });

  it('quietWindowMs<=0（窗口关）→ 一片一条，与关窗时的现网一致', () => {
    expect(chunksOf([
      event(1, 0, 'peer', '甲'),
      event(2, 0, 'peer', '乙'),
    ], 0)).toHaveLength(2);
  });

  it('增量同步用严格小于：恰好等于窗口的续句不再合并', () => {
    const pair = [event(1, 0, 'peer', '甲'), event(2, 12000, 'peer', '乙')];
    expect(chunksOf(pair, 12000, { strictGap: true })).toHaveLength(2);
    expect(chunksOf(pair, 12000, { strictGap: false })).toHaveLength(1);
  });

  it('chunk 的 time 取首片时间（出处要的是「什么时候说的」）', () => {
    const chunks = chunksOf([
      event(1, 1700000000000, 'peer', '甲'),
      event(2, 1700000005000, 'peer', '乙'),
    ], 12000);
    expect(chunks[0]!.time).toBe(1700000000000);
  });

  it('脚手架整段不算正文：带历史的轮次只留当前那句', () => {
    const chunks = chunksOf([event(1, 0, 'peer', SCAFFOLD)], 12000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).not.toContain('Chat history');
    expect(chunks[0]!.text).not.toContain('/home/');
    expect(chunks[0]!.textLen).toBe('猫粮太贵了，一包要两百多'.length);
  });

  it('图片痕迹只记布尔，不记路径', () => {
    const withMark = chunksOf([event(1, 0, 'peer', '这图里是什么 [图片]')], 12000);
    expect(withMark[0]!.hasMedia).toBe(true);
    const withLine = chunksOf([event(1, 0, 'peer', '那张图\n└ Image: /tmp/x.png')], 12000);
    expect(withLine[0]!.hasMedia).toBe(true);
    expect(withLine[0]!.text).not.toContain('/tmp/');
    expect(chunksOf([event(1, 0, 'peer', '纯文字')], 12000)[0]!.hasMedia).toBe(false);
  });

  it('只有图片行、没有正文 → 丢弃而不是留下空 chunk', () => {
    const result = chunkEvents([event(1, 0, 'peer', '└ Image: /home/anon/.dsh-qqbot-akane/media/a_1_x.png')], 12000);
    expect(result.chunks).toEqual([]);
    expect(result.dropped).toEqual([{ seq: 1, reason: 'empty' }]);
  });

  it('被判定丢弃的轮次单独报原因（渲染形状变了要能发现）', () => {
    const result = chunkEvents([
      event(1, 0, 'peer', '甲'),
      event(2, 1000, 'peer', SCAFFOLD.replace('[Current message] 猫粮太贵了，一包要两百多', '')),
      event(3, 2000, 'peer', '   '),
    ], 12000);
    expect(result.chunks).toHaveLength(1);
    expect(result.dropped).toEqual([
      { seq: 2, reason: 'no-current-message' },
      { seq: 3, reason: 'empty' },
    ]);
  });
});
