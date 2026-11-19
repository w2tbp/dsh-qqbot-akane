/**
 * 分词对拍 —— MEMORY.md §3 限制 2 的守卫，P0 的开工前置条件
 *
 * 基准是 python `tokenizers` 官方实现在同一条 `tokenizer.json` 上跑出来的 349 条 id 序列
 * （`tokenizer-golden.json`，含 8 句真实语料 + 300 条随机中文 + 41 条边界形状：ASCII 标点、
 * 大小写、全角、零宽、控制字符、码点>64k、空串、1048 字符长句）。
 *
 * 结论（11-19 实测）：`bge-node-probe.mjs` 的手写 WordPiece **202/349 不一致**，
 * 官方纯 JS 实现 **0/349**。所以生产路径用官方实现，本脚本负责它不退化：
 *
 * - 升级 `@huggingface/tokenizers`
 * - 换模型 / 换权重文件
 * - 有人把手写分词塞回来
 *
 * 都会在这里红。**对拍不过就别往下走** —— 索引建在错 token 上是不可见的腐坏。
 *
 * 跑法（需要权重在 model/ 或 --model-dir 指定的目录）：
 *   node verify-tokenizer.mjs            # 0 退出 = 全一致
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tokenizer } from '@huggingface/tokenizers';
import { DEFAULT_MODEL_DIR } from './embed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modelDir = process.argv.includes('--model-dir')
  ? process.argv[process.argv.indexOf('--model-dir') + 1]
  : process.env.AKANE_EMBED_MODEL_DIR ?? DEFAULT_MODEL_DIR;
const goldenFile = path.join(here, 'tokenizer-golden.json');

const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
const tokenizer = new Tokenizer(
  JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8')),
  JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer_config.json'), 'utf8')),
);

let mismatch = 0;
const first = [];
for (const row of golden.rows) {
  const ids = Array.from(tokenizer.encode(row.text, { add_special_tokens: true }).ids ?? []);
  if (ids.length !== row.ids.length || ids.some((id, index) => id !== row.ids[index])) {
    mismatch += 1;
    if (first.length < 3) first.push({ len: row.ids.length, got: ids.length });
  }
}

console.log(JSON.stringify({
  ref: golden.ref,
  rows: golden.rows.length,
  mismatch,
  // 只打形状差异，绝不打正文与完整 id 序列（fixture 虽为合成语料，日志面一律按最小暴露处理）
  sample: first,
}));
process.exit(mismatch === 0 ? 0 : 1);
