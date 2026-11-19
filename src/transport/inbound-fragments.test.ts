/**
 * 合并批次在入站渲染里的归属保真（spec §3.1 US-3/US-4 + §3.5 US-28 的输入侧）
 *
 * 与 fragment-merge.test.ts 的分工：那边证明 onMerge 交给下游什么，
 * 这边证明她最终读到什么形状。
 */
import { describe, expect, it } from 'vitest';
import { assembleAgentBody, type MiddlewareState, type ProcessedMessage } from './inbound.ts';
import type { FragmentView } from '../middleware/fragment-merge.ts';
import type { ChatScope, Logger } from '../types.ts';

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function msg(overrides: Partial<ProcessedMessage> = {}): ProcessedMessage {
  return {
    rawEventType: 'GROUP_MESSAGE_CREATE',
    kind: 'group',
    senderId: 'SENDER-1',
    senderName: '阿肥',
    content: '第三片',
    messageId: 'MSG-3',
    timestamp: '1700000000',
    groupOpenid: 'GROUP-OPENID',
    ...overrides,
  };
}

function fragment(senderId: string, senderName: string, content: string): FragmentView {
  return { senderId, senderName, content };
}

function assemble(
  state: MiddlewareState,
  scope: ChatScope = 'group',
  overrides: Partial<ProcessedMessage> = {},
): string | null {
  return assembleAgentBody(msg(overrides), state, scope, logger);
}

const mention = { wasMentioned: true, implicit: false };

describe('未合并时的形状不得有任何变化（US-8 回归门）', () => {
  it('群聊单条：逐字节等于改动前的输出', () => {
    expect(assemble({ mention })).toBe('[阿肥 (SENDER-1)] 第三片 (@you)');
  });

  it('私聊单条：不带发送人壳', () => {
    expect(assemble({ mention }, 'c2c')).toBe('第三片');
  });

  it('分片视图只有一片：与单条同形', () => {
    const body = assemble({ mention, akaneMergedFragments: [fragment('SENDER-1', '阿肥', '第三片')] });
    expect(body).toBe('[阿肥 (SENDER-1)] 第三片 (@you)');
  });
});

describe('同一人连发（群）—— 裸拼不加分段壳', () => {
  const fragments = [
    fragment('SENDER-1', '阿肥', '第一片'),
    fragment('SENDER-1', '阿肥', '第二片'),
    fragment('SENDER-1', '阿肥', '第三片'),
  ];

  it('三片都在，且不出现 [Merged messages ...] 壳', () => {
    const body = assemble({ mention, akaneMergedFragments: fragments })!;
    expect(body).toContain('[阿肥 (SENDER-1)] 第一片');
    expect(body).toContain('[阿肥 (SENDER-1)] 第二片');
    expect(body).not.toContain('[Merged messages begins]');
    expect(body).not.toContain('[Current message]');
  });

  it('触发标记只贴最后一片', () => {
    const body = assemble({ mention, akaneMergedFragments: fragments })!;
    const lines = body.split('\n');
    expect(lines.filter((l) => l.includes('(@you)'))).toHaveLength(1);
    expect(lines[lines.length - 1]).toContain('(@you)');
  });

  it('隐式唤醒时用的是「有人喊你」，同样只出现在最后一行', () => {
    const body = assemble({ mention: { wasMentioned: false, implicit: true }, akaneMergedFragments: fragments })!;
    expect(body).toContain('（有人喊你）');
    expect(body).not.toContain('(@you)');
  });
});

describe('不同人各自连发（群）—— 分段保归属', () => {
  const fragments = [
    fragment('SENDER-1', '阿肥', '甲的第一句'),
    fragment('SENDER-2', '小李', '乙插了一句'),
    fragment('SENDER-1', '阿肥', '第三片'),
  ];

  it('前置分片段包在壳里，最后一片单独跟在 [Current message] 后', () => {
    const body = assemble({ mention, akaneMergedFragments: fragments })!;
    const lines = body.split('\n');
    expect(lines[0]).toBe('[Merged messages begins]');
    expect(lines[1]).toBe('[阿肥 (SENDER-1)] 甲的第一句');
    expect(lines[2]).toBe('[小李 (SENDER-2)] 乙插了一句');
    expect(lines[3]).toBe('[Merged messages ends]');
    expect(lines[4]).toBe('[Current message]');
    expect(lines[5]).toBe('[阿肥 (SENDER-1)] 第三片 (@you)');
  });

  it('两个人的话不会被读成一个人说的（defaultMerge 的失败形状）', () => {
    const body = assemble({ mention, akaneMergedFragments: fragments })!;
    expect(body).not.toContain('甲的第一句\n乙插了一句\n第三片');
  });
});

describe('空壳与纯附件分片', () => {
  it('早期分片没有文字（只发了图）时不产生空行', () => {
    const fragments = [
      fragment('SENDER-1', '阿肥', ''),
      fragment('SENDER-1', '阿肥', '第三片'),
    ];
    const body = assemble({ mention, akaneMergedFragments: fragments })!;
    expect(body.split('\n').filter((l) => l.trim() === '')).toHaveLength(0);
    expect(body).toBe('[阿肥 (SENDER-1)] 第三片 (@you)');
  });

  it('幸存者自己是空壳、早期分片有文字 → 整批不许被当成空消息丢掉', () => {
    // 形状："@她 帮我看" → "就这张图"（第二片清洗后没字），幸存者是第二片
    const fragments = [
      fragment('SENDER-1', '阿肥', '帮我看这个'),
      fragment('SENDER-1', '阿肥', ''),
    ];
    const body = assemble({ mention, akaneMergedFragments: fragments }, 'group', { content: '' });
    expect(body).not.toBeNull();
    expect(body).toContain('帮我看这个');
  });

  it('整批一句字都没有、群聊又没被唤醒 → 仍然丢弃（不新增任何输出）', () => {
    const fragments = [fragment('SENDER-1', '阿肥', ''), fragment('SENDER-1', '阿肥', '')];
    const body = assemble(
      { mention: { wasMentioned: false, implicit: false }, akaneMergedFragments: fragments },
      'group',
      { content: '' },
    );
    expect(body).toBeNull();
  });
});

describe('私聊批次（分桶键就是同一个人）', () => {
  it('多片裸拼、不加发送人壳、不加分段壳', () => {
    const fragments = [
      fragment('SENDER-1', '阿肥', '第一片'),
      fragment('SENDER-1', '阿肥', '第三片'),
    ];
    const body = assemble({ mention, akaneMergedFragments: fragments }, 'c2c')!;
    expect(body).toBe('第一片\n第三片');
    expect(body).not.toContain('[Merged messages begins]');
    expect(body).not.toContain('阿肥');
  });
});
