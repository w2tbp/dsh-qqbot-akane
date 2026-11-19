// 官方 @huggingface/tokenizers（Rust 绑定）能否直接吃 tokenizer.json，并与 python 基准逐位一致
// 注意：这个包名下面向两种实现，`Tokenizer.fromFile` 只在带原生二进制的构建里有。
// 现网 embed-service 装的是纯 JS 那份（`new Tokenizer(tjson, cjson)`，见 hfjs_check.mjs），
// 所以本脚本要单独指一个安装目录：AKANE_TK_OFFICIAL_DIR=<装了原生构建的目录>。
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const OFFICIAL = process.env.AKANE_TK_OFFICIAL_DIR;
if (!OFFICIAL) {
  console.error('需要 AKANE_TK_OFFICIAL_DIR（指向另装一份原生构建的目录）；现网通路请跑 hfjs_check.mjs');
  process.exit(2);
}
const { Tokenizer } = require(path.join(OFFICIAL, 'node_modules/@huggingface/tokenizers'));

const DIR = process.env.AKANE_EMBED_MODEL_DIR || path.join(HERE, '..', 'model');
const GOLDEN = process.env.AKANE_TOKENIZER_GOLDEN || path.join(HERE, '..', 'tokenizer-golden.json');
const tk = Tokenizer.fromFile(path.join(DIR, 'tokenizer.json'));

const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
let bad = 0;
const out = [];
for (const row of golden.rows) {
  const enc = tk.encode(row.text, true);
  const ids = enc.tokens.ids ? enc.tokens.ids : enc.ids;
  const got = Array.from(ids);
  if (got.length !== row.ids.length || got.some((v, i) => v !== row.ids[i])) {
    bad++;
    out.push([row.text.slice(0, 30), row.ids.slice(0, 10), got.slice(0, 10)]);
  }
}
console.log(JSON.stringify({ total: golden.rows.length, mismatch: bad, version: require(path.join(OFFICIAL, 'node_modules/@huggingface/tokenizers/package.json')).version }, null, 1));
for (const r of out.slice(0, 10)) console.log(r);
