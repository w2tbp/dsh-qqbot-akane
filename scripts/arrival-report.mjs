#!/usr/bin/env node
/**
 * 到达间隔报告 —— 把插桩落盘的 arrival/*.jsonl 汇成静默窗口的定值依据
 *
 * 用法：node scripts/arrival-report.mjs [目录]
 *   目录默认 ~/.dsh-qqbot-akane/arrival
 *
 * 口径写死在这里，不在命令行上开放（spec §3.5 US-31：每次重算换一个数字，
 * 那份数据就等于没有）：只统计同桶相邻两条、间隔 < 120s 的对，
 * 报 p50/p90/p95 与样本量；样本 < 300 对只出「继续攒」，不出可用值。
 *
 * 读的是 lib/ 构建产物（本仓库刻意把 lib/ 入库），所以不依赖 tsx / 不需先 build。
 */
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAX_PAIR_GAP_MS, MIN_PAIRS_FOR_DECISION, summarizeArrivals } from '../lib/features/arrival-stats.js';

const dir = process.argv[2] ?? join(homedir(), '.dsh-qqbot-akane', 'arrival');

/** 坏行只跳过：插桩是观测，不该因为一行被截断就整个报告读不出来 */
function parse(text) {
  const out = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.t === 'number' && typeof r.k === 'string') out.push(r);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { records: out, bad };
}

let names;
try {
  names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
} catch (err) {
  console.error(`读不到目录 ${dir}: ${err.message}`);
  console.error('插桩没开过就是零文件 —— 先在 cordis.patch.yml 的 fork 条目里打开 arrivalProbe.enabled');
  process.exit(1);
}

const all = [];
let badLines = 0;
for (const name of names) {
  const { records, bad } = parse(await readFile(join(dir, name), 'utf8'));
  all.push(...records);
  badLines += bad;
}

const buckets = new Set(all.map((r) => r.k)).size;
console.log(`目录：${dir}`);
console.log(`文件：${names.length} 个　记录：${all.length} 条　坏行：${badLines} 条　桶数：${buckets}`);
console.log(`口径：同桶相邻两条，间隔 < ${MAX_PAIR_GAP_MS / 1000}s；样本门槛 ${MIN_PAIRS_FOR_DECISION} 对\n`);

for (const [label, onlyWoke] of [['全部消息', false], ['只算点过她的桶', true]]) {
  const s = summarizeArrivals(all, onlyWoke);
  console.log(`【${label}】对数 ${s.pairs}（同刻重复 ${s.duplicates} 对）`);
  if (!s.enough) {
    console.log(`  样本不足 ${MIN_PAIRS_FOR_DECISION} 对 → 继续攒，不要拿这个数定 quietWindowMs\n`);
    continue;
  }
  console.log(`  p50 ${s.p50}ms　p90 ${s.p90}ms　p95 ${s.p95}ms`);
  console.log(`  候选 quietWindowMs ≈ ${s.p90}（D2：取 p90，不是均值）\n`);
}
console.log('注意：p90 是「她每一次回复都要多等的钱」，定值前先看现网可接受延迟，别只对着数字抄。');
