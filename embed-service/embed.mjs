/**
 * bge-small-zh-v1.5 的本机推理内核 —— server.mjs 与 selftest.mjs 共用同一条通路。
 *
 * 为什么「共用」是硬要求：索引里的向量与查询向量必须来自**同一** tokenizer、同一池化、
 * 同一归一化，否则余弦没有意义。两处各写一遍迟早漂。
 *
 * 分词用官方纯 JS 实现 `@huggingface/tokenizers@0.2.0`（`new Tokenizer(tokenizer.json,
 * tokenizer_config.json)`），**不是手写复刻**：MEMORY.md §3 限制 2 的实测结论是手写
 * WordPiece 与 python `tokenizers` 参考基准 349 条里错 202 条（ASCII 标点、英文大小写、
 * 空白、码点>64k 全错），而官方 JS 同一批 **0 错**。`verify-tokenizer.mjs` 把这条钉住，
 * 因为它是整条索引的地基 —— 版本升级、换实现、权重被动过，都会在这里红。
 *
 * 512 的截断来自 `tokenizer_config.json` 的 `model_max_length`（Bert 系默认 right 截断），
 * 所以两个 json 都要读，只读 tokenizer.json 会丢掉这条。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ort from 'onnxruntime-web';
import { Tokenizer } from '@huggingface/tokenizers';

export const MODEL_ID = 'Xenova/bge-small-zh-v1.5';
export const DEFAULT_MODEL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'model');

/** 只保 q8：fp32 94.9MB 不进项目资产（11-19 用户拍板） */
const WEIGHT_FILE = 'model_quantized.onnx';
const JSON_FILES = ['tokenizer.json', 'tokenizer_config.json', 'config.json', 'special_tokens_map.json'];

function readJson(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) throw new Error(`${name} 缺失：${file} —— 先跑 install.sh 取权重`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function loadModel(modelDir = process.env.AKANE_EMBED_MODEL_DIR || DEFAULT_MODEL_DIR) {
  for (const name of [WEIGHT_FILE, ...JSON_FILES]) {
    if (!fs.existsSync(path.join(modelDir, name))) {
      throw new Error(`${name} 缺失于 ${modelDir} —— 先跑 install.sh`);
    }
  }

  const tokenizer = new Tokenizer(readJson(modelDir, 'tokenizer.json'), readJson(modelDir, 'tokenizer_config.json'));
  const config = readJson(modelDir, 'config.json');
  const dims = Number(config.hidden_size);
  if (!Number.isInteger(dims) || dims <= 0) throw new Error(`config.json 的 hidden_size 不是正整数：${config.hidden_size}`);

  ort.env.wasm.numThreads = Number(process.env.AKANE_EMBED_THREADS ?? 1);
  const started = Date.now();
  const session = await ort.InferenceSession.create(path.join(modelDir, WEIGHT_FILE), {
    graphOptimizationLevel: 'all',
  });
  const loadMs = Date.now() - started;

  const wantsTypeIds = session.inputNames.includes('token_type_ids');
  const outName = session.outputNames.includes('last_hidden_state') ? 'last_hidden_state' : session.outputNames[0];

  /** 暴露给分词对拍：id 序列与 token_type_ids，不带张量 */
  function encodeOne(text) {
    return tokenizer.encode(String(text), { add_special_tokens: true, return_token_type_ids: true });
  }

  /**
   * 批量嵌入：右侧 pad 到本批最长，mean-pool over attention==1，再 L2 归一化。
   * 返回长度与入参一致、顺序一致 —— 索引侧靠这个对齐写 `vectors.f32.bin`。
   */
  async function embed(texts) {
    if (texts.length === 0) return [];
    const encoded = texts.map((text) => encodeOne(text));
    const width = Math.max(1, ...encoded.map((item) => item.ids.length));
    const inputIds = new BigInt64Array(texts.length * width);
    const attention = new BigInt64Array(texts.length * width);
    const typeIds = new BigInt64Array(texts.length * width);

    encoded.forEach((item, row) => {
      const mask = item.attention_mask ?? [];
      const types = item.token_type_ids ?? [];
      for (let col = 0; col < width; col += 1) {
        const index = row * width + col;
        if (col < item.ids.length) {
          inputIds[index] = BigInt(item.ids[col]);
          attention[index] = BigInt(mask[col] ?? 1);
          typeIds[index] = BigInt(types[col] ?? 0);
        } // 其余留 0：id 0 就是 [PAD]（本模型词表实测），attention 0
      }
    });

    const shape = [texts.length, width];
    const feed = {
      input_ids: new ort.Tensor('int64', inputIds, shape),
      attention_mask: new ort.Tensor('int64', attention, shape),
    };
    if (wantsTypeIds) feed.token_type_ids = new ort.Tensor('int64', typeIds, shape);

    const output = await session.run(feed);
    const tensor = output[outName];
    const [, , hidden] = tensor.dims;
    if (hidden !== dims) throw new Error(`输出维度 ${hidden} 与 config.json 的 ${dims} 不符`);

    const vectors = [];
    for (let row = 0; row < texts.length; row += 1) {
      const sum = new Float64Array(hidden);
      let count = 0;
      for (let col = 0; col < width; col += 1) {
        if (attention[row * width + col] !== 1n) continue;
        count += 1;
        const base = (row * width + col) * hidden;
        for (let h = 0; h < hidden; h += 1) sum[h] += tensor.data[base + h];
      }
      const vector = new Float32Array(hidden);
      let norm = 0;
      for (let h = 0; h < hidden; h += 1) {
        const value = count > 0 ? sum[h] / count : 0;
        vector[h] = value;
        norm += value * value;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) for (let h = 0; h < hidden; h += 1) vector[h] /= norm;
      vectors.push(vector);
    }
    return vectors;
  }

  return { model: MODEL_ID, dims, loadMs, embed, encode: encodeOne, tokenizer, session };
}
