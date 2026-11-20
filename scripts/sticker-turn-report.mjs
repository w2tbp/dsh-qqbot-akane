#!/usr/bin/env node
/**
 * 每轮配图报告 —— 把 sticker-turns/*.jsonl 汇成 stickerLevel 的定档依据
 *
 * 用法：node scripts/sticker-turn-report.mjs [目录]
 *   目录默认 ~/.dsh-qqbot-akane/sticker-turns
 *
 * 口径写死在 src/features/sticker-turn-stats.ts（本脚本只读盘 + 打印），理由与
 * arrival-report 相同：每次重算换一个数字，那份数据就等于没有。
 *
 * 分子只认 k（落在梗图库下的张数）。占比的对比只在**同一 scope、同一档**之间成立，
 * 且某档轮数不足 MIN_TURNS_FOR_DECISION 时只出数、不出结论。
 *
 * 读的是 lib/ 构建产物（本仓库刻意把 lib/ 入库），所以不依赖 tsx / 不需先 build。
 */
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_TURNS_FOR_DECISION,
  TIER_ORDER,
  summarizeStickerTurns,
} from '../lib/features/sticker-turn-stats.js';

const dir = process.argv[2] ?? join(homedir(), '.dsh-qqbot-akane', 'sticker-turns');

/** 坏行只跳过并计数：观测不该因为一行被截断就整个报告读不出来 */
function parse(text) {
  const out = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const ok = typeof r.t === 'number'
        && (r.s === 'g' || r.s === 'c')
        && Number.isFinite(r.i) && Number.isFinite(r.k)
        && TIER_ORDER.includes(r.l);
      if (ok) out.push(r);
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
  console.error('观测没开过就是零文件 —— 先在 cordis.patch.yml 的 fork 条目里打开 stickerProbe.enabled');
  process.exit(1);
}

const all = [];
let badLines = 0;
for (const name of names) {
  const { records, bad } = parse(await readFile(join(dir, name), 'utf8'));
  all.push(...records);
  badLines += bad;
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
console.log(`目录：${dir}`);
console.log(`文件：${names.length} 个　轮次：${all.length} 条　坏行：${badLines} 条`);
if (all.length > 0) {
  const ts = all.map((r) => r.t);
  console.log(`跨度：${day(Math.min(...ts))} ~ ${day(Math.max(...ts))}（UTC）`);
}
console.log(`口径：分子 = present 声明且落在梗图库下的轮次；比较门槛 ${MIN_TURNS_FOR_DECISION} 轮/档\n`);

const summary = summarizeStickerTurns(all);

function table(title, rows, note) {
  console.log(`【${title}】`);
  if (rows.length === 0) {
    console.log(`  零记录 → ${note}\n`);
    return;
  }
  for (const r of rows) {
    const pct = (r.ratio * 100).toFixed(1).padStart(5);
    const gate = r.enough ? '' : '　← 样本不足，别据此定档';
    console.log(`  ${r.level.padEnd(7)} ${String(r.turns).padStart(4)} 轮　配了梗图 ${String(r.withGallery).padStart(3)} 轮　${pct}%　共 ${String(r.galleryImages).padStart(3)} 张${gate}`);
  }
  console.log(`  ${note}\n`);
}

table('群聊（档位真正作用的那一栏）', summary.group, '想看档位有没有效，只看这一栏的档间差');
table('私聊（对照组）', summary.c2c, '档位不改私聊 persona ⇒ 这一栏本该不随档位动');

console.log('三条读数纪律：');
console.log('  1) 占比是 present **声明**数，不是实发数；也不含 akane_send_file（那是用户点名要图，不算主动配图）。');
console.log('  2) 没有「同一 scope、改档前后各 ≥' + MIN_TURNS_FOR_DECISION + ' 轮」的对比，任何一档都不许写成「已验证有效」。');
console.log('  3) 若占比涨了而绝对张数没涨，先查群被动额度（ReplyLimiter limit:4）与 msgid-cache TTL 5min，别回去改措辞。');
