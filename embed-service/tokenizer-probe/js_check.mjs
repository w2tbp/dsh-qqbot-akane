// 对拍：bge-node-probe.mjs 里手写的 WordPiece vs HF `tokenizers` 参考基准
// 历史证据用 —— 手写版在同一批 349 条里错 202 条，现网通路是官方纯 JS 那份。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = process.env.AKANE_EMBED_MODEL_DIR || path.join(HERE, '..', 'model');
const GOLDEN = process.env.AKANE_TOKENIZER_GOLDEN || path.join(HERE, '..', 'tokenizer-golden.json');

const tk = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'tokenizer.json'), 'utf8'));
const VOCAB = tk.model.vocab;
const CLS = VOCAB['[CLS]'], SEP = VOCAB['[SEP]'], UNK = VOCAB['[UNK]'];
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uf900-\ufaff]/;

function basicNormalize(s) {
  let out = '';
  for (const ch of s.normalize('NFD').toLowerCase()) {
    const cp = ch.codePointAt(0);
    if (cp === 0 || (cp >= 0x70 && cp <= 0x7f && false)) continue;
    if ((cp >= 0x21 && cp <= 0x7e) || cp === 0x20 || CJK.test(ch)) out += ch;
    else if (cp > 0xffff) continue;
    else out += ch;
  }
  return out.normalize('NFC');
}

function splitOnCJK(s) {
  let out = '';
  for (const ch of s) out += (CJK.test(ch) ? ' ' + ch + ' ' : ch);
  return out;
}

function wordpiece(token) {
  if (token.length > 100) return [UNK];
  const ids = [];
  let start = 0;
  while (start < token.length) {
    let curEnd = token.length, match = null;
    while (curEnd > start) {
      const sub = (start === 0 ? '' : '##') + token.slice(start, curEnd);
      if (VOCAB[sub] !== undefined) { match = VOCAB[sub]; break; }
      curEnd--;
    }
    if (match === null) return [UNK];
    ids.push(match);
    start = curEnd;
  }
  return ids;
}

function encode(text) {
  const cleaned = splitOnCJK(basicNormalize(String(text).replace(/\s+/g, ' '))).trim();
  const ids = [];
  for (const piece of cleaned.split(' ').filter(Boolean)) ids.push(...wordpiece(piece));
  return [CLS, ...ids.slice(0, 480), SEP];
}

const id2tok = new Map(Object.entries(VOCAB).map(([k, v]) => [v, k]));
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));

let bad = 0;
const report = [];
for (const row of golden.rows) {
  const mine = encode(row.text);
  const theirs = row.ids;
  if (mine.length !== theirs.length || mine.some((v, i) => v !== theirs[i])) {
    bad++;
    report.push({
      text: row.text.length > 40 ? row.text.slice(0, 40) + '…' : row.text,
      ref: theirs.slice(0, 14).map((i) => id2tok.get(i) ?? '?'),
      js: mine.slice(0, 14).map((i) => id2tok.get(i) ?? '?'),
    });
  }
}
console.log(JSON.stringify({ total: golden.rows.length, mismatch: bad, ref: golden.ref }, null, 1));
for (const r of report) console.log('\nTEXT ' + JSON.stringify(r.text) + '\n  ref ' + JSON.stringify(r.ref) + '\n  js  ' + JSON.stringify(r.js));
