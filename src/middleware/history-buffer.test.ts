import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dns from 'node:dns';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import {
  akaneHistoryBuffer,
  extractHistoryAttachments,
  sanitizeHistoryContent,
} from './history-buffer.ts';
import { GroupHistoryStore } from '../features/history-store.ts';
import { MediaLedger } from '../features/media-ledger.ts';
import type { Logger, RawAttachment } from '../types.ts';

vi.mock('../media/media-cleaner.ts', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { MEDIA_ROOT: mkdtempSync(join(tmpdir(), 'dsh-history-media-')) };
});

import { MEDIA_ROOT } from '../media/media-cleaner.ts';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const HASH_A = '0334E26858735CFFB95059EC241B1262';
const HASH_B = '6A45210673BA996517C9F008BC99F593';

/** 落盘是 fire-and-forget（不能拖慢触发路径），断言前要把链跑完 */
async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

const fetchMock = vi.fn(async () => new Response(new Uint8Array(gif)));

function imageMessage(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'group',
    senderId: 'OPENID-1',
    senderName: '阿肥',
    content: '看这个',
    messageId: `MSG-${Math.random().toString(36).slice(2)}`,
    timestamp: '1762000000000',
    groupOpenid: 'GROUP-1',
    ...overrides,
  };
}

function imageAttachment(filename = `${HASH_A}.jpg`): RawAttachment {
  return { content_type: 'image/png', filename, size: gif.length, url: 'https://cdn.example.com/pic/a' };
}

function harness(options: {
  limit?: number;
  enabled?: boolean;
  dailyCap?: number;
  groupKey?: (ctx: MiddlewareContext) => string | undefined;
} = {}) {
  const store = new GroupHistoryStore();
  const ledger = new MediaLedger();
  const mw = akaneHistoryBuffer({
    limit: options.limit ?? 10,
    store,
    media: { enabled: options.enabled ?? true, maxMB: 1, ttlHours: 24 },
    logger,
    ledger,
    groupKey: options.groupKey ?? (() => 'APP:G1'),
  });
  const run = async (message: Record<string, unknown>) => {
    const ctx = { message, state: {}, log: { debug: () => {} } } as unknown as MiddlewareContext;
    let through = false;
    await mw(ctx, async () => { through = true; });
    return { ctx, through };
  };
  return { store, ledger, mw, run };
}

beforeEach(() => {
  vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['8.8.8.8']);
  fetchMock.mockImplementation(async () => new Response(new Uint8Array(gif)));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  vi.clearAllMocks();
  rmSync(MEDIA_ROOT, { recursive: true, force: true });
});

describe('akaneHistoryBuffer 记录语义', () => {
  it('先取旧缓冲再记录：自己的那条不在自己的 history 里', async () => {
    const h = harness();
    const first = await h.run(imageMessage({ messageId: 'M1' }));
    expect(first.ctx.state.history).toEqual([]);
    expect(first.through).toBe(true);

    const second = await h.run(imageMessage({ messageId: 'M2' }));
    const seen = (second.ctx.state.history as unknown as Array<{ messageId: string }>);
    expect(seen.map(e => e.messageId)).toEqual(['M1']);
  });

  it('未 @ 她的消息照样进历史（挂在 mentionGate 之前才有意义）', async () => {
    const h = harness();
    await h.run(imageMessage({ content: '今天去爬山吗' }));
    expect(h.store.list('APP:G1', 10)[0]?.content).toBe('今天去爬山吗');
  });

  it('同一条消息重复推送只记一次', async () => {
    const h = harness();
    await h.run(imageMessage({ messageId: 'M1' }));
    await h.run(imageMessage({ messageId: 'M1' }));
    expect(h.store.list('APP:G1', 10)).toHaveLength(1);
  });

  it('超出 limit 从头淘汰', async () => {
    const h = harness({ limit: 2 });
    for (const id of ['M1', 'M2', 'M3']) await h.run(imageMessage({ messageId: id }));
    expect(h.store.list('APP:G1', 2).map(e => e.messageId)).toEqual(['M2', 'M3']);
  });

  it('非群消息不进历史，但照常放行', async () => {
    const h = harness({ groupKey: () => undefined });
    const result = await h.run({ ...imageMessage(), kind: 'c2c' });
    expect(result.through).toBe(true);
    expect(result.ctx.state.history).toBeUndefined();
    expect(h.store.size()).toBe(0);
  });
});

describe('历史条目的附件元数据', () => {
  it('图片消息：条目带上 contentType/filename/size/url', async () => {
    const h = harness();
    await h.run(imageMessage({ content: '', attachments: [imageAttachment()] }));
    const entry = h.store.list('APP:G1', 10)[0]!;
    expect(entry.attachments).toEqual([
      { contentType: 'image/png', filename: `${HASH_A}.jpg`, size: gif.length, url: 'https://cdn.example.com/pic/a' },
    ]);
  });

  it('语音不进附件（有 ASR 文本就走正文，落盘也没用）', async () => {
    const h = harness();
    await h.run(imageMessage({
      attachments: [{ content_type: 'audio/silk', filename: 'v.silk', size: 10, url: 'https://cdn.example.com/v' }],
    }));
    expect(h.store.list('APP:G1', 10)[0]?.attachments).toBeUndefined();
  });
});

describe('记录时落盘', () => {
  it('未 @ 她的群图片也下载，路径进账本', async () => {
    const h = harness();
    await h.run(imageMessage({ content: '', attachments: [imageAttachment()] }));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readdirSync(MEDIA_ROOT)).toHaveLength(1);
    expect(h.ledger.resolve({ filename: `${HASH_A}.jpg` })).toBeTruthy();
  });

  it('同一张图群里重复发：只拉一次', async () => {
    const h = harness();
    await h.run(imageMessage({ messageId: 'M1', attachments: [imageAttachment()] }));
    await settle();
    await h.run(imageMessage({ messageId: 'M2', attachments: [imageAttachment(`${HASH_A}.png`)] }));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readdirSync(MEDIA_ROOT)).toHaveLength(1);
  });

  it('当日配额用尽后不再主动下载，但元数据仍在（渲染成 [图片]）', async () => {
    const h = harness();
    // 配额上限是常量 20，这里只验「第 21 条不再拉」
    for (let i = 0; i < 21; i++) {
      const hash = i.toString(16).padStart(32, '0');
      await h.run(imageMessage({ messageId: `M${i}`, attachments: [imageAttachment(`${hash}.jpg`)] }));
    }
    await settle(40);
    expect(fetchMock).toHaveBeenCalledTimes(20);
    const last = h.store.list('APP:G1', 1)[0]!;
    expect(last.attachments?.[0]?.filename).toContain('.jpg');
  });

  it('机器人自己的图片不落盘', async () => {
    const h = harness();
    await h.run(imageMessage({ senderIsBot: true, attachments: [imageAttachment()] }));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.store.list('APP:G1', 10)[0]?.attachments).toHaveLength(1);
  });

  it('media.enabled=false：只记元数据，一次都不下载', async () => {
    const h = harness({ enabled: false });
    await h.run(imageMessage({ attachments: [imageAttachment()] }));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.store.list('APP:G1', 10)[0]?.attachments).toHaveLength(1);
  });

  it('视频/文件只记「有过这个东西」，不主动落盘', async () => {
    const h = harness();
    await h.run(imageMessage({
      attachments: [{ content_type: 'video/mp4', filename: 'clip.mp4', size: 999, url: 'https://cdn.example.com/clip' }],
    }));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.store.list('APP:G1', 10)[0]?.attachments?.[0]?.contentType).toBe('video/mp4');
  });

  it('下载失败不影响消息处理，也不占着账本', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('ETIMEDOUT'); });
    const h = harness();
    const result = await h.run(imageMessage({ attachments: [imageAttachment()] }));
    await settle();
    expect(result.through).toBe(true);
    expect(h.ledger.resolve({ filename: `${HASH_A}.jpg` })).toBeUndefined();
  });
});

describe('sanitizeHistoryContent（只洗存进历史的副本）', () => {
  it('新格式表情标签：解出 ext 里的文本', () => {
    const ext = Buffer.from(JSON.stringify({ text: '疼死我了' }), 'utf-8').toString('base64');
    expect(sanitizeHistoryContent(`<faceType=1,faceId="178",ext="${ext}">`)).toBe('【表情: 疼死我了】');
  });

  it('新格式解不出来：整段去掉，不留 base64 噪声', () => {
    expect(sanitizeHistoryContent('前<faceType=1,faceId="178",ext="!!!not-base64!!!">后')).toBe('前后');
  });

  it('老格式：需要 face-id→emoji 表才能翻译，不抄 SDK 的表，直接去掉', () => {
    expect(sanitizeHistoryContent('开心 [<face,id=125/>]')).toBe('开心');
  });

  it('普通文本原样，@marker 不动（与当前消息链路保持一致）', () => {
    expect(sanitizeHistoryContent('<@1D800988> akane 在吗')).toBe('<@1D800988> akane 在吗');
  });

  it('不改写 ctx.message.content —— 唤醒链路看到的还是原文', async () => {
    const message = imageMessage({ content: 'akane [<face,id=125/>]' });
    const h = harness();
    await h.run(message);
    expect(message.content).toBe('akane [<face,id=125/>]');
    expect(h.store.list('APP:G1', 10)[0]?.content).toBe('akane');
  });
});

describe('extractHistoryAttachments（纯函数）', () => {
  it('无附件 → undefined，不产生空数组', () => {
    expect(extractHistoryAttachments(undefined)).toBeUndefined();
    expect(extractHistoryAttachments([])).toBeUndefined();
  });

  it('图片和文件都留下，语音被剔除，顺序保持', () => {
    const kept = extractHistoryAttachments([
      imageAttachment(),
      { content_type: 'audio/silk', filename: 'v', size: 1, url: 'https://e.com/v' },
      { content_type: 'file', filename: 'a.pdf', size: 2, url: 'https://e.com/a.pdf' },
    ])!;
    expect(kept.map(a => a.contentType)).toEqual(['image/png', 'file']);
  });

  it('缺 size / 缺 url 的畸形附件不炸', () => {
    const kept = extractHistoryAttachments([{ content_type: 'image/png', filename: '', size: 0, url: '' } as RawAttachment])!;
    expect(kept[0]).toEqual({ contentType: 'image/png', filename: '', size: 0, url: '' });
  });
});
