import { describe, expect, it, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { AKANE_MERGED_FRAGMENTS, mergeFragments, onMergeBufferFull } from './fragment-merge.ts';
import type { RawAttachment } from '../types.ts';

/** 最小 ctx 替身：onMerge 只读 message 的三个字段和 state 这一个槽位 */
function makeCtx(overrides: {
  senderId?: string;
  senderName?: string;
  content?: string;
  messageId?: string;
  attachments?: RawAttachment[];
} = {}): MiddlewareContext {
  return {
    message: {
      kind: 'group',
      senderId: overrides.senderId ?? 'OPENID-1',
      ...(overrides.senderName !== undefined ? { senderName: overrides.senderName } : {}),
      content: overrides.content ?? '',
      messageId: overrides.messageId ?? 'MSG-1',
      ...(overrides.attachments ? { attachments: overrides.attachments } : {}),
    },
    state: {},
  } as unknown as MiddlewareContext;
}

function image(filename: string): RawAttachment {
  return { content_type: 'image/png', filename, size: 1024, url: `https://cdn.example.com/${filename}` };
}

describe('mergeFragments —— 幸存者选择（US-1）', () => {
  it('单片时原样返回，不写分片视图', () => {
    const only = makeCtx({ content: '就一句话' });
    expect(mergeFragments([only])).toBe(only);
    expect((only.state as Record<string, unknown>)[AKANE_MERGED_FRAGMENTS]).toBeUndefined();
  });

  it('幸存者取最后一片，不是最早一片', () => {
    // SDK 的 defaultMerge 取 buffered[0]，会把被动回复锚在离过期最近的 msg_id 上
    const first = makeCtx({ content: '第一片', messageId: 'MSG-A' });
    const last = makeCtx({ content: '第三片', messageId: 'MSG-C' });
    expect(mergeFragments([first, makeCtx({ content: '第二片', messageId: 'MSG-B' }), last])).toBe(last);
  });

  it('幸存者的 content 不被拼接改写（归属交给入站渲染，不在这里糊成一团）', () => {
    const a = makeCtx({ content: '张三的第一句', senderId: 'OPENID-1' });
    const b = makeCtx({ content: '李四插了一句', senderId: 'OPENID-2' });
    const survivor = mergeFragments([a, b]);
    expect(survivor.message.content).toBe('李四插了一句');
  });
});

describe('mergeFragments —— 附件汇总（US-2）', () => {
  it('只有图没有字的分片，附件照样进幸存者', () => {
    // 这是 "@她 + 单发一张图" 的失败形状：defaultMerge 按 content!=='' 过滤，整张图会丢
    const text = makeCtx({ content: '帮我看这个', attachments: [image('a.jpg')] });
    const pictureOnly = makeCtx({ content: '', attachments: [image('b.jpg')] });

    const survivor = mergeFragments([text, pictureOnly]);
    const filenames = (survivor.message.attachments ?? []).map((a) => (a as RawAttachment).filename);
    expect(filenames).toEqual(['a.jpg', 'b.jpg']);
  });

  it('附件按到达顺序汇总，不是按幸存者顺序', () => {
    const first = makeCtx({ content: '一', attachments: [image('1.jpg')] });
    const mid = makeCtx({ content: '', attachments: [image('2.jpg'), image('3.jpg')] });
    const last = makeCtx({ content: '三', attachments: [image('4.jpg')] });

    const survivor = mergeFragments([first, mid, last]);
    const filenames = (survivor.message.attachments ?? []).map((a) => (a as RawAttachment).filename);
    expect(filenames).toEqual(['1.jpg', '2.jpg', '3.jpg', '4.jpg']);
  });

  it('整批都没有附件时不写入空数组（保持与今天逐字节一致）', () => {
    const survivor = mergeFragments([makeCtx({ content: '一' }), makeCtx({ content: '二' })]);
    expect(survivor.message.attachments).toBeUndefined();
  });
});

describe('mergeFragments —— 分片视图（US-3 / US-28 的输入）', () => {
  it('按到达顺序记录每片的发送人与文字，含幸存者自己', () => {
    const a = makeCtx({ content:  '甲', senderId: 'OPENID-1', senderName: '阿肥' });
    const b = makeCtx({ content: '乙', senderId: 'OPENID-2' });

    const survivor = mergeFragments([a, b]);
    expect((survivor.state as Record<string, unknown>)[AKANE_MERGED_FRAGMENTS]).toEqual([
      { senderId: 'OPENID-1', senderName: '阿肥', content: '甲' },
      { senderId: 'OPENID-2', content: '乙' },
    ]);
  });

  it('没有发送人昵称时不写 senderName 键（否则渲染层会把 undefined 当名字用）', () => {
    const survivor = mergeFragments([makeCtx({ content: '甲' }), makeCtx({ content: '乙' })]);
    const views = (survivor.state as Record<string, unknown>)[AKANE_MERGED_FRAGMENTS] as Array<Record<string, unknown>>;
    expect('senderName' in views[0]!).toBe(false);
  });

  it('视图里的文字是清洗后 trim 过的原文，不受幸存者内容改写影响', () => {
    const a = makeCtx({ content: '  带空格  ' });
    const survivor = mergeFragments([a, makeCtx({ content: '尾' })]);
    const views = (survivor.state as Record<string, unknown>)[AKANE_MERGED_FRAGMENTS] as Array<{ content: string }>;
    expect(views[0]!.content).toBe('带空格');
  });
});

describe('onMergeBufferFull —— 缓冲溢出留痕（US-5）', () => {
  it('记一条 warn，含 msgId 与聊天类型，不含正文', () => {
    const logger = { warn: vi.fn() };
    onMergeBufferFull(logger)(makeCtx({ content: '不该进日志的聊天内容', messageId: 'MSG-X' }));
    const line = logger.warn.mock.calls[0]![0] as string;
    expect(line).toContain('MSG-X');
    expect(line).toContain('group');
    expect(line).not.toContain('不该进日志的聊天内容');
  });
});
