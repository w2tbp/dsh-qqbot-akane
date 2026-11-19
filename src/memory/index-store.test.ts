/**
 * T2 三文件的磁盘形状（§9 测试 8 / 9 的地基）
 *
 * 整目录是**可丢弃的派生缓存**：删掉能全量重建、插件照常启动。
 * 所以这里对不一致一律「判脏 → 清空」而不是试图修 —— 两个文件错位比缺一半更难查。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMBED_DIMS,
  EMBED_MODEL_ID,
  INDEX_SCHEMA,
  appendRows,
  chunkKey,
  emptyMeta,
  loadIndex,
  readChunkRows,
  readVectors,
  wipeIndex,
  writeMeta,
  type ChunkRow,
} from './index-store.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'akane-index-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function row(key: string, text: string, peer = 'c2c:oA'): ChunkRow {
  const [sessionId, range] = key.split(':');
  const [seqStart, seqEnd] = range!.split('-').map(Number);
  return {
    key,
    sessionId: sessionId!,
    peer,
    seqStart: seqStart!,
    seqEnd: seqEnd!,
    time: 1700000000000,
    role: 'peer',
    hasMedia: false,
    textLen: text.length,
    text,
  };
}

function unit(oneAt = 0): number[] {
  const v = new Array<number>(EMBED_DIMS).fill(0);
  v[oneAt] = 1;
  return v;
}

function seed(rows: ChunkRow[], vectors: number[][]): void {
  writeFileSync(join(dir, 'chunks.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const buffer = new Float32Array(EMBED_DIMS * rows.length);
  vectors.forEach((v, i) => buffer.set(v, i * EMBED_DIMS));
  writeFileSync(join(dir, 'vectors.f32.bin'), Buffer.from(buffer.buffer));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...emptyMeta(), chunks: rows.length }, null, 1));
}

describe('空与缺失（§9 测试 9：整目录删掉也照常）', () => {
  it('目录为空 → state=empty，不抛', async () => {
    const status = await loadIndex(dir);
    expect(status.state).toBe('empty');
    if (status.state === 'empty') expect(status.meta.chunks).toBe(0);
  });

  it('目录根本不存在 → 也是 empty，并把目录建出来', async () => {
    const missing = join(dir, 'index');
    expect(existsSync(missing)).toBe(false);
    expect((await loadIndex(missing)).state).toBe('empty');
    expect(existsSync(missing)).toBe(true);
  });

  it('meta.json 损坏（JSON 解析不了）→ empty 而不是抛', async () => {
    writeFileSync(join(dir, 'chunks.jsonl'), '');
    writeFileSync(join(dir, 'meta.json'), '{ 半截');
    expect((await loadIndex(dir)).state).toBe('empty');
  });

  it('wipeIndex 对不存在的目录不抛', async () => {
    await expect(wipeIndex(join(dir, 'nope'))).resolves.toBeUndefined();
  });
});

describe('正常读写', () => {
  it('appendRows 写三文件，loadIndex 认成 ready 且 keys 完整', async () => {
    const rows = [row('s-a:1-1', '猫粮太贵了'), row('s-a:2-3', '今天加班')];
    const meta = { ...emptyMeta(), cursors: { 's-a': 3 }, chunks: 2 };
    await appendRows(dir, rows, [unit(0), unit(1)], meta);

    const status = await loadIndex(dir);
    expect(status.state).toBe('ready');
    if (status.state === 'ready') {
      expect(status.keys).toEqual(new Set(rows.map((r) => r.key)));
      expect(status.meta.cursors).toEqual({ 's-a': 3 });
    }
    expect(await readChunkRows(dir)).toEqual(rows);
  });

  it('向量按行序回读（余弦靠的是这个对齐）', async () => {
    const rows = [row('s:1-1', '甲'), row('s:2-2', '乙'), row('s:3-3', '丙')];
    await appendRows(dir, rows, [unit(0), unit(1), unit(2)], { ...emptyMeta(), chunks: 3 });
    const back = await readVectors(dir, rows.length);
    expect(back).toHaveLength(3);
    expect(Array.from(back![1]!).slice(0, 3)).toEqual([0, 1, 0]);
    expect(back![2]![2]).toBe(1);
  });

  it('零行只写 meta，不碰两个数据文件', async () => {
    await appendRows(dir, [], [], { ...emptyMeta(), cursors: { 's-a': 9 } });
    expect(readdirSync(dir)).toEqual(['meta.json']);
    expect(existsSync(join(dir, 'chunks.jsonl'))).toBe(false);
  });

  it('meta 走 tmp + rename：写完不留 .tmp', async () => {
    await writeMeta(dir, emptyMeta());
    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('rows 与 vectors 数量不符 / 维度不符 → 抛在写盘之前', async () => {
    const rows = [row('s:1-1', '甲'), row('s:2-2', '乙')];
    await expect(appendRows(dir, rows, [unit(0)], emptyMeta())).rejects.toThrow(/mismatch/);
    await expect(appendRows(dir, rows, [unit(0), [1, 2, 3]], emptyMeta())).rejects.toThrow(/dim mismatch/);
    expect(existsSync(join(dir, 'chunks.jsonl'))).toBe(false);
  });

  it('chunkKey 用坐标不用内容 hash（文本变了同一条还是同一条）', () => {
    expect(chunkKey('s-a', 3, 5)).toBe('s-a:3-5');
  });
});

describe('判脏即清空（§4「不许新旧混存」）', () => {
  const rows = [row('s:1-1', '甲')];

  it.each([
    ['schema', (m: ReturnType<typeof emptyMeta>) => ({ ...m, schema: INDEX_SCHEMA + 1 })],
    ['model', (m: ReturnType<typeof emptyMeta>) => ({ ...m, model: 'some-other-model' })],
    ['dims', (m: ReturnType<typeof emptyMeta>) => ({ ...m, dims: 384 })],
  ])('%s 变了 → rebuilt(schema) 且两个数据文件被清掉', async (_label, mutate) => {
    const meta = mutate(emptyMeta());
    seed(rows, [unit(0)]);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, chunks: 1 }, null, 1));

    const status = await loadIndex(dir);
    expect(status.state).toBe('rebuilt');
    if (status.state === 'rebuilt') expect(status.reason).toBe('schema');
    expect(existsSync(join(dir, 'chunks.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'vectors.f32.bin'))).toBe(false);
    expect(existsSync(join(dir, 'meta.json'))).toBe(false);
    expect(status.meta.model).toBe(EMBED_MODEL_ID);
  });

  it('jsonl 半行（写入被打断）→ rebuilt(corrupt)，不做逐行修补', async () => {
    seed(rows, [unit(0)]);
    writeFileSync(join(dir, 'chunks.jsonl'), readFileSync(join(dir, 'chunks.jsonl'), 'utf8') + '{"key":"s:2-2","tex');
    const status = await loadIndex(dir);
    expect(status.state).toBe('rebuilt');
    if (status.state === 'rebuilt') expect(status.reason).toBe('corrupt');
  });

  it('向量字节数与条数对不上 → rebuilt(corrupt)', async () => {
    seed(rows, [unit(0)]);
    writeFileSync(join(dir, 'vectors.f32.bin'), Buffer.alloc(EMBED_DIMS * 4 - 7));
    expect((await loadIndex(dir)).state).toBe('rebuilt');
  });

  it('缺向量文件也算错位（宁缺毋滥，不拿空向量算相似度）', async () => {
    seed(rows, [unit(0)]);
    rmSync(join(dir, 'vectors.f32.bin'));
    const status = await loadIndex(dir);
    expect(status.state).toBe('rebuilt');
    if (status.state === 'rebuilt') expect(status.reason).toBe('corrupt');
  });

  it('脏了之后下一轮 appendRows 能重建出 ready', async () => {
    seed(rows, [unit(0)]);
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...emptyMeta(), dims: 384, chunks: 1 }, null, 1));
    expect((await loadIndex(dir)).state).toBe('rebuilt');
    const fresh = [row('s:9-9', '重建后的第一条')];
    await appendRows(dir, fresh, [unit(3)], { ...emptyMeta(), chunks: 1 });
    expect((await loadIndex(dir)).state).toBe('ready');
    expect(await readChunkRows(dir)).toEqual(fresh);
  });
});

describe('readVectors 的数量守卫（§9 测试 10 的降级依据）', () => {
  it('文件比要的条数短 → undefined，调用方走字面档', async () => {
    seed([row('s:1-1', '甲'), row('s:2-2', '乙')], [unit(0), unit(1)]);
    expect(await readVectors(dir, 3)).toBeUndefined();
    expect(await readVectors(dir, 2)).toHaveLength(2);
  });

  it('文件不在 → undefined', async () => {
    expect(await readVectors(dir, 1)).toBeUndefined();
  });
});
