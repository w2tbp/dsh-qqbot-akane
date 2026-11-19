/**
 * 一次性自检 —— 不起服务、不占端口、不常驻（§7 P0 验收第 1 条「通路跑得通」的最小证据）
 *
 * 它验的是**运行时通路**：权重能加载、分词能出 512 维、同义句比无关句更像，
 * 以及**超过 512 token 的输入被截断而不是把推理炸掉**（11-19 现网回填第一跳死在这上面）。
 * 这三条过了，`server.mjs` 与插件侧 `embed-client` 才有意义。
 *
 * 那 6 对相似度是 §3 的**冒烟数字**，不是召回质量基线 —— 这里只断言序关系
 * （同义对 > 无关对），不断言具体值：具体值随实现与硬件漂，而阈值属于 P2。
 */
import { loadModel } from './embed.mjs';

const SENTENCES = [
  '猫粮太贵了，一包要两百多',
  '这个猫粮的价格不便宜',
  '今天加班到十点才走',
  '她喜欢红色的雨伞',
  '我家熊猫好胖',
  '这猫粮多少钱',
  '龙猫好看吗',
  '我们上次说的那张图里是什么',
];

/** 与 §3 同一批句对：[同义/相关, 期望高] 与 [无关, 期望低] */
const RELATED = [[0, 1], [1, 5], [0, 5]];
const UNRELATED = [[0, 2], [3, 4], [6, 2]];

const model = await loadModel(process.argv.includes('--model-dir')
  ? process.argv[process.argv.indexOf('--model-dir') + 1]
  : undefined);

const vectors = await model.embed(SENTENCES);
const cos = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
};

const related = RELATED.map(([i, j]) => cos(vectors[i], vectors[j]));
const unrelated = UNRELATED.map(([i, j]) => cos(vectors[i], vectors[j]));

// 单条一问一答的往返耗时（插件召回走的就是这条形状）
const started = Date.now();
for (let i = 0; i < 20; i += 1) await model.embed([SENTENCES[0]]);
const singleTurnMs = (Date.now() - started) / 20;

const minRelated = Math.min(...related);
const maxUnrelated = Math.max(...unrelated);

/**
 * 长文回归 —— 11-19 现网回填第一跳就是死在这形状上：>512 token 的 chunk 撑爆 Bert 位置编码，
 * WASM 抛原生异常（日志只剩一个数字指针），整轮回填原地重撞。断言的是**这条通路本身**：
 * 不抛、出 512 维、单位长，而且**尾部被丢掉**（截断是 right truncation，不是别的处理）——
 * 最后这条同时是它自己的代价声明：cos≈1 不代表内容重复，只代表前 512 token 相同。
 */
const UNIT = '猫粮太贵了，一包要两百多，不知道能不能便宜点。';
const long = UNIT.repeat(80); // 实测 1042 token，远超 512
const longWithTail = long + '完全不一样的尾巴，本来应该被截断丢掉。';
let longError = '';
let longMs = 0;
let longVector = null;
let tailCos = 0;
let normErr = 0;
try {
  const batchStarted = Date.now();
  const rows = Array.from({ length: 8 }, (_, i) => (i === 0 ? long : longWithTail));
  const batch = await model.embed(rows);
  longMs = Date.now() - batchStarted;
  longVector = batch[0];
  tailCos = cos(longVector, batch[1]);
  normErr = Math.abs(Math.sqrt(cos(longVector, longVector)) - 1);
} catch (err) {
  longError = String(err && err.message ? err.message : err).slice(0, 80) || 'NATIVE_EXCEPTION';
}

const longOk = longError === ''
  && longVector !== null
  && longVector.length === model.dims
  && normErr < 1e-3
  && tailCos > 0.9999;

const ok = vectors.every((v) => v.length === model.dims) && minRelated > maxUnrelated && longOk;

console.log(JSON.stringify({
  model: model.model,
  dims: model.dims,
  loadMs: model.loadMs,
  singleTurnMs: Number(singleTurnMs.toFixed(1)),
  rssMB: Math.round(process.memoryUsage().rss / 1048576),
  related: related.map((value) => Number(value.toFixed(4))),
  unrelated: unrelated.map((value) => Number(value.toFixed(4))),
  invariant: { minRelated: Number(minRelated.toFixed(4)), maxUnrelated: Number(maxUnrelated.toFixed(4)) },
  longText: {
    rawTokens: model.encode(long).ids.length,
    batch8Ms: longMs,
    tailCos: Number(tailCos.toFixed(6)),
    normErr: Number(normErr.toExponential(2)),
    error: longError || undefined,
  },
  pass: ok,
}, null, 1));

process.exit(ok ? 0 : 1);
