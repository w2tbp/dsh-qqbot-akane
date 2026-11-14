import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaLedger, mediaDedupKey } from './media-ledger.ts';

let root = '';
/** 造一个真实存在的文件：resolve() 要查存在性，假路径骗不过它 */
function file(name: string, bytes = 'x'): string {
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}

const HASH_A = '0334E26858735CFFB95059EC241B1262';
const HASH_B = '6A45210673BA996517C9F008BC99F593';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-ledger-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('mediaDedupKey（同一张图必须算出同一个键）', () => {
  it('MD5 文件名：忽略 size —— 引用消息那条链路从 SDK 拿不到 size', () => {
    expect(mediaDedupKey({ filename: `${HASH_A}.jpg`, size: 0 }))
      .toBe(mediaDedupKey({ filename: `${HASH_A}.jpg`, size: 12345 }));
  });

  it('MD5 文件名：大小写、扩展名差异不拆开同一张图', () => {
    expect(mediaDedupKey({ filename: `${HASH_A}.jpeg` }))
      .toBe(mediaDedupKey({ filename: `${HASH_A.toLowerCase()}.png` }));
  });

  it('非 MD5 文件名：不敢假定名字绑定内容，size 参与键', () => {
    const a = mediaDedupKey({ filename: '微信图片.jpg', size: 100 });
    const b = mediaDedupKey({ filename: '微信图片.jpg', size: 200 });
    expect(a).not.toBe(b);
    expect(a).toContain('微信图片.jpg');
  });

  it('只有 URL：去掉查询串（签名每次都变，留着就永远去不了重）', () => {
    const a = mediaDedupKey({ url: 'https://cdn.example.com/pic/1.png?sign=aaa' });
    const b = mediaDedupKey({ url: 'https://cdn.example.com/pic/1.png?sign=bbb' });
    expect(a).toBe(b);
    expect(a).not.toContain('sign');
  });

  it('拿不到任何稳定标识 → 空串（调用方按不可去重处理）', () => {
    expect(mediaDedupKey({})).toBe('');
  });
});

describe('MediaLedger.resolve / fetch', () => {
  it('下载一次即入账，之后 resolve 直接命中不再下载', async () => {
    const ledger = new MediaLedger();
    const work = vi.fn(async () => file('a.png'));
    const att = { filename: `${HASH_A}.jpg`, size: 10, url: 'https://e.com/a' };

    const first = await ledger.fetch(att, work);
    expect(first).toBeTruthy();
    expect(ledger.resolve(att)).toBe(first);
    await ledger.fetch(att, work);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('同一张图并发到达：只跑一次下载，两边拿到同一个路径', async () => {
    const ledger = new MediaLedger();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const work = vi.fn(async () => { await gate; return file('a.png'); });
    const att = { filename: `${HASH_A}.jpg` };

    const both = Promise.all([ledger.fetch(att, work), ledger.fetch(att, work)]);
    release?.();
    const [x, y] = await both;
    expect(work).toHaveBeenCalledTimes(1);
    expect(x).toBe(y);
  });

  it('不同图不互相顶掉', async () => {
    const ledger = new MediaLedger();
    const a = await ledger.fetch({ filename: `${HASH_A}.jpg` }, async () => file('a.png'));
    const b = await ledger.fetch({ filename: `${HASH_B}.jpg` }, async () => file('b.png'));
    expect(ledger.resolve({ filename: `${HASH_A}.jpg` })).toBe(a);
    expect(ledger.resolve({ filename: `${HASH_B}.jpg` })).toBe(b);
  });

  it('下载失败不记账：下一条同样的消息还会再试（失败通常是网络抖动）', async () => {
    const ledger = new MediaLedger();
    const att = { filename: `${HASH_A}.jpg` };
    const failed = await ledger.fetch(att, async () => undefined);
    expect(failed).toBeUndefined();
    const work = vi.fn(async () => file('a.png'));
    await ledger.fetch(att, work);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('文件被 TTL 清掉后：resolve 给出未命中，而不是把死路径递出去', async () => {
    const ledger = new MediaLedger();
    const att = { filename: `${HASH_A}.jpg` };
    const path = await ledger.fetch(att, async () => file('a.png'));
    rmSync(path!);
    expect(ledger.resolve(att)).toBeUndefined();
    // 死条目已被踢出账本，再下载会重新记账
    const fresh = file('b.png');
    ledger.remember(mediaDedupKey(att), fresh);
    expect(ledger.resolve(att)).toBe(fresh);
  });

  it('不可去重的附件：每次都真下载，也不污染账本', async () => {
    const ledger = new MediaLedger();
    const work = vi.fn(async () => file('a.png'));
    await ledger.fetch({}, work);
    await ledger.fetch({}, work);
    expect(work).toHaveBeenCalledTimes(2);
    expect(ledger.resolve({})).toBeUndefined();
  });

  it('去重缓存超过上限按 FIFO 淘汰，长跑不无限增长', async () => {
    const ledger = new MediaLedger(2);
    for (const hash of [HASH_A, HASH_B, '11111111111111111111111111111111']) {
      await ledger.fetch({ filename: `${hash}.jpg` }, async () => file(`${hash}.png`));
    }
    expect(ledger.resolve({ filename: `${HASH_A}.jpg` })).toBeUndefined();
    expect(ledger.resolve({ filename: '11111111111111111111111111111111.jpg' })).toBeTruthy();
  });
});

describe('MediaLedger 群维度当日配额', () => {
  it('取满上限后不再允许，且各群互不影响', () => {
    const ledger = new MediaLedger();
    for (let i = 0; i < 20; i++) expect(ledger.tryConsumeQuota('APP:G1')).toBe(true);
    expect(ledger.tryConsumeQuota('APP:G1')).toBe(false);
    expect(ledger.tryConsumeQuota('APP:G2')).toBe(true);
    expect(ledger.quotaUsed('APP:G1')).toBe(20);
  });

  it('跨天重置', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 14, 23, 59));
    const ledger = new MediaLedger();
    for (let i = 0; i < 20; i++) ledger.tryConsumeQuota('APP:G1');
    expect(ledger.tryConsumeQuota('APP:G1')).toBe(false);

    vi.setSystemTime(new Date(2026, 10, 15, 0, 1));
    expect(ledger.quotaUsed('APP:G1')).toBe(0);
    expect(ledger.tryConsumeQuota('APP:G1')).toBe(true);
  });

  it('上限设 0 = 主动落盘完全关闭', () => {
    const ledger = new MediaLedger();
    expect(ledger.tryConsumeQuota('APP:G1', 0)).toBe(false);
  });

  it('自定义上限生效', () => {
    const ledger = new MediaLedger();
    expect(ledger.tryConsumeQuota('APP:G1', 2)).toBe(true);
    expect(ledger.tryConsumeQuota('APP:G1', 2)).toBe(true);
    expect(ledger.tryConsumeQuota('APP:G1', 2)).toBe(false);
  });
});
