// 官方纯 JS `@huggingface/tokenizers@0.2.0` vs python 基准 —— 这条就是现网通路，
// 349 条 0 错是在这个组合上证的。包按名字解析（embed-service/node_modules 在本目录之上）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tokenizer } from '@huggingface/tokenizers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.AKANE_EMBED_MODEL_DIR || path.join(HERE, '..', 'model');
const GOLDEN = process.env.AKANE_TOKENIZER_GOLDEN || path.join(HERE, '..', 'tokenizer-golden.json');
const tjson = JSON.parse(fs.readFileSync(path.join(DIR, 'tokenizer.json'), 'utf8'));
const cjson = JSON.parse(fs.readFileSync(path.join(DIR, 'tokenizer_config.json'), 'utf8'));

const tk = new Tokenizer(tjson, cjson);

const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
let bad = 0;
const out = [];
for (const row of golden.rows) {
  let got;
  try {
    const enc = tk.encode(row.text, { add_special_tokens: true });
    got = Array.from(enc.ids ?? []);
  } catch (e) {
    got = ['THREW:' + String(e.message).slice(0, 40)];
  }
  if (JSON.stringify(got) !== JSON.stringify(row.ids)) {
    bad++;
    out.push({ text: row.text.slice(0, 24), ref: row.ids.slice(0, 12), got: got.slice(0, 12) });
  }
}
console.log(JSON.stringify({ total: golden.rows.length, mismatch: bad }, null, 1));
for (const r of out.slice(0, 12)) console.log(JSON.stringify(r, null, 0));
