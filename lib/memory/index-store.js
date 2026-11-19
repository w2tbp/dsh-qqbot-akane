/**
 * T2 语义索引的磁盘形状（§4：一期三个文件，不上数据库）
 *
 * `chunks.jsonl` 追加文本 + 元数据，`vectors.f32.bin` 同序定长，`meta.json` 记
 * schema / 模型 / 维度 / 每份转录的游标。规模账：她现 4 份转录 chunk 后估 1–2k 条
 * × 512 维 × 4B ≈ 2–4MB，暴力余弦全扫完全够，**一期不引入 ANN / 向量库**。
 *
 * 整目录是**可丢弃的派生缓存**：删掉能全量重建，插件照常启动（§7 P0 验收第 1 条）。
 * 因此这里对不一致的处理一律是「判脏 → 清空」而不是试图修：两个文件错位比缺一半
 * 更难查，而重建代价只是几十秒后台时间。
 *
 * 键是 `{sessionId, seqStart, seqEnd}`，**不用内容 hash** —— 折叠文本会因渲染细节变，
 * hash 一漂索引就重复增长（§4）。
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLUGIN_HOME } from "../shared/dirs.js";
export const INDEX_SCHEMA = 1;
export const EMBED_MODEL_ID = 'Xenova/bge-small-zh-v1.5';
export const EMBED_DIMS = 512;
/** 索引根目录（她自己的数据目录，不进 ~/.dsh） */
export const INDEX_ROOT = join(PLUGIN_HOME, 'index');
export function emptyMeta() {
    return {
        schema: INDEX_SCHEMA,
        model: EMBED_MODEL_ID,
        dims: EMBED_DIMS,
        cursors: {},
        chunks: 0,
        updatedAt: 0,
    };
}
function paths(dir) {
    return {
        chunks: join(dir, 'chunks.jsonl'),
        vectors: join(dir, 'vectors.f32.bin'),
        meta: join(dir, 'meta.json'),
    };
}
/** 删掉整个索引内容（目录留着，权限不动）：整目录可丢弃，所以不需要备份 */
export async function wipeIndex(dir) {
    const p = paths(dir);
    for (const file of [p.chunks, p.vectors, p.meta]) {
        await rm(file, { force: true });
    }
}
/**
 * 读盘并自证一致。
 *
 * 判脏的两种情形（§4「不许新旧混存」）：meta 与当前 schema/model/dims 不符，
 * 或 `vectors.f32.bin` 的字节数不等于 `chunks × dims × 4`。
 */
export async function loadIndex(dir) {
    const p = paths(dir);
    let meta;
    let jsonl;
    try {
        jsonl = await readFile(p.chunks, 'utf8');
        meta = JSON.parse(await readFile(p.meta, 'utf8'));
    }
    catch {
        await mkdir(dir, { recursive: true });
        return { state: 'empty', meta: emptyMeta() };
    }
    if (meta.schema !== INDEX_SCHEMA || meta.model !== EMBED_MODEL_ID || meta.dims !== EMBED_DIMS) {
        await wipeIndex(dir);
        return { state: 'rebuilt', meta: emptyMeta(), reason: 'schema' };
    }
    const keys = new Set();
    for (const line of jsonl.split('\n')) {
        if (line.trim() === '')
            continue;
        try {
            const row = JSON.parse(line);
            if (typeof row.key === 'string')
                keys.add(row.key);
        }
        catch {
            // 半行（写入被打断）→ 整个索引判脏，不做逐行修补
            await wipeIndex(dir);
            return { state: 'rebuilt', meta: emptyMeta(), reason: 'corrupt' };
        }
    }
    let bytes = 0;
    try {
        bytes = (await stat(p.vectors)).size;
    }
    catch {
        bytes = 0;
    }
    if (bytes !== keys.size * EMBED_DIMS * 4) {
        await wipeIndex(dir);
        return { state: 'rebuilt', meta: emptyMeta(), reason: 'corrupt' };
    }
    return { state: 'ready', meta: { ...meta, cursors: { ...meta.cursors } }, keys };
}
/** 全量读回 chunk 行（P1 的暴力余弦与字面档都吃这份；2–4MB 量级下直接进内存） */
export async function readChunkRows(dir) {
    const p = paths(dir);
    let jsonl;
    try {
        jsonl = await readFile(p.chunks, 'utf8');
    }
    catch {
        return [];
    }
    const rows = [];
    for (const line of jsonl.split('\n')) {
        if (line.trim() === '')
            continue;
        try {
            rows.push(JSON.parse(line));
        }
        catch {
            /* 由 loadIndex 负责判脏，这里只跳过 */
        }
    }
    return rows;
}
/**
 * 按行序读回向量（P1 的暴力余弦吃这份）。
 *
 * 返回 `undefined` 表示文件与 `count` 不匹配 —— 调用方据此走字面档而不是崩：
 * 向量与文本错位时拿错向量算相似度，比召不回来严重得多。
 */
export async function readVectors(dir, count) {
    const p = paths(dir);
    let buffer;
    try {
        buffer = await readFile(p.vectors);
    }
    catch {
        return undefined;
    }
    const expected = count * EMBED_DIMS * 4;
    if (buffer.byteLength < expected)
        return undefined;
    const view = new DataView(buffer.buffer, buffer.byteOffset, expected);
    const rows = [];
    for (let i = 0; i < count; i += 1) {
        const vector = new Float32Array(EMBED_DIMS);
        for (let h = 0; h < EMBED_DIMS; h += 1)
            vector[h] = view.getFloat32(i * EMBED_DIMS * 4 + h * 4, true);
        rows.push(vector);
    }
    return rows;
}
/** 追加写：文本行、向量、meta 三步。任何一步抛都由调用方计入重试（≤3） */
export async function appendRows(dir, rows, vectors, meta) {
    if (rows.length === 0) {
        await writeMeta(dir, meta);
        return;
    }
    if (rows.length !== vectors.length)
        throw new Error('akane index: rows/vectors length mismatch');
    const p = paths(dir);
    await mkdir(dir, { recursive: true });
    const lines = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    const buffer = new Float32Array(vectors.length * EMBED_DIMS);
    vectors.forEach((vector, i) => {
        if (vector.length !== EMBED_DIMS)
            throw new Error('akane index: vector dim mismatch');
        buffer.set(vector, i * EMBED_DIMS);
    });
    await appendOrThrow(p.chunks, lines);
    await appendOrThrow(p.vectors, Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    await writeMeta(dir, meta);
}
async function appendOrThrow(file, data) {
    const handle = await open(file, 'a');
    try {
        await handle.writeFile(data);
    }
    finally {
        await handle.close();
    }
}
/** meta 走 tmp + rename 原子写（与设置页保存同一手法） */
export async function writeMeta(dir, meta) {
    await mkdir(dir, { recursive: true });
    const p = paths(dir);
    const tmp = `${p.meta}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...meta, updatedAt: Date.now() }, null, 1));
    await rename(tmp, p.meta);
}
export function chunkKey(sessionId, seqStart, seqEnd) {
    return `${sessionId}:${seqStart}-${seqEnd}`;
}
//# sourceMappingURL=index-store.js.map