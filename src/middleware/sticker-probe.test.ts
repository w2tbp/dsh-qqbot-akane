import { mkdtemp, readdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStickerProbe, STICKER_PROBE_ROOT, startStickerProbeCleanup } from './sticker-probe.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { PresentedFileRef } from '../transport/events.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let root = '';
let workdir = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'akane-sticker-probe-'));
  workdir = await mkdtemp(join(tmpdir(), 'akane-sticker-work-'));
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(workdir, { recursive: true, force: true }),
  ]);
});

function config(overrides: Partial<ImQQBotConfig> = {}): ImQQBotConfig {
  return {
    cwd: workdir,
    stickerLevel: 'normal',
    stickerProbe: { enabled: true, keepDays: 30 },
    ...overrides,
  } as unknown as ImQQBotConfig;
}

async function readRecords(): Promise<Array<Record<string, unknown>>> {
  const names = (await readdir(root)).filter((n) => n.endsWith('.jsonl'));
  const all = await Promise.all(names.map((n) => readFile(join(root, n), 'utf8')));
  return all.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('关闭态零行为变化', () => {
  it('enabled 不为 true ⇒ 不返回写入器，目录也不会被创建', async () => {
    const dir = join(root, 'off');
    expect(createStickerProbe(config({ stickerProbe: { enabled: false, keepDays: 30 } }), logger, dir)).toBeUndefined();
    expect(createStickerProbe(config({ stickerProbe: undefined }), logger, dir)).toBeUndefined();
    await expect(stat(dir)).rejects.toThrow();
  });

  it('清理定时器同样不挂：effect 一次都不会被调用', () => {
    const effects = vi.fn();
    const ctx = { effect: effects } as never;
    startStickerProbeCleanup(ctx, config({ stickerProbe: { enabled: false, keepDays: 30 } }), logger);
    expect(effects).not.toHaveBeenCalled();
    startStickerProbeCleanup(ctx, config(), logger);
    expect(effects).toHaveBeenCalledTimes(1);
  });
});

describe('记录形状（隐私红线）', () => {
  it('一条 = 一个轮次，字段只有 t/s/i/k/l —— 路径、正文、openid 一个都不写', async () => {
    const probe = createStickerProbe(config(), logger, root)!;
    probe.writeTurn('group', [{ path: join(workdir, 'stickers', '从来没觉得上班开心过.jpg') }]);
    await probe.flush();

    const records = await readRecords();
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0]!).sort()).toEqual(['i', 'k', 'l', 's', 't']);
    const raw = JSON.stringify(records[0]);
    expect(raw).not.toContain(workdir);
    expect(raw).not.toContain('从来没觉得上班开心过');
    expect(raw).not.toContain('openid');
  });

  it('scope 只留 g/c 一个字母；档位记的是写入器创建时的快照', async () => {
    const probe = createStickerProbe(config({ stickerLevel: 'active' }), logger, root)!;
    probe.writeTurn('group', []);
    probe.writeTurn('c2c', []);
    await probe.flush();

    const records = await readRecords();
    expect(records.map((r) => r.s)).toEqual(['g', 'c']);
    expect(records.every((r) => r.l === 'active')).toBe(true);
  });
});

describe('图片计数口径', () => {
  it('i 数所有图片扩展名（大小写不敏感），k 只数落在梗图库目录下的那几张', async () => {
    const probe = createStickerProbe(config(), logger, root)!;
    const gallery = join(workdir, 'stickers');
    probe.writeTurn('group', [
      { path: join(gallery, '翻白眼.PNG') },          // 图 + 在库里
      { path: join(workdir, 'ark-images', 'selfie.jpg') }, // 图，但不是梗图
      { path: join(workdir, '报告.pdf') },            // 非图
      { path: join(workdir, 'noext') },               // 无扩展名
    ] satisfies PresentedFileRef[]);
    await probe.flush();

    const [record] = await readRecords();
    expect(record!.i).toBe(2);
    expect(record!.k).toBe(1);
  });

  it('同名的库目录出现在别处不算：前缀按 cwd 现算，不是猜字符串', async () => {
    const other = await mkdtemp(join(tmpdir(), 'akane-sticker-other-'));
    try {
      const probe = createStickerProbe(config(), logger, root)!;
      probe.writeTurn('group', [{ path: join(other, 'stickers', '别人的图.jpg') }]);
      await probe.flush();
      const [record] = await readRecords();
      expect(record!.i).toBe(1);
      expect(record!.k).toBe(0);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('零图片的轮次照样落一行 —— 分母就是从这里来的', async () => {
    const probe = createStickerProbe(config(), logger, root)!;
    probe.writeTurn('group', []);
    await probe.flush();
    const [record] = await readRecords();
    expect(record!.i).toBe(0);
    expect(record!.k).toBe(0);
  });

  it('磁盘故障只 warn 一次，且不影响她的回复通路', async () => {
    const blocker = join(root, 'blocker');
    await writeFile(blocker, 'x', 'utf8');
    const probe = createStickerProbe(config(), logger, join(blocker, 'sub'))!;
    for (let i = 0; i < 5; i += 1) probe.writeTurn('group', [{ path: join(workdir, 'stickers', `a${i}.jpg`) }]);
    await probe.flush();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('落盘位置', () => {
  it('默认根目录在插件数据目录下的 sticker-turns/，与 arrival/ 并列不混写', () => {
    expect(STICKER_PROBE_ROOT.endsWith(join('.dsh-qqbot-akane', 'sticker-turns'))).toBe(true);
  });
});
