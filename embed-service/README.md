# embed-service —— 本机常驻 embedding 服务

akane 记忆库（`docs/specs/2026-11-19-akane-memory-stack.md` §14）的语义档依赖它。
它**是一个独立进程**，不是 `dsh web` 的一部分：ONNX 推理塞进插件进程会把她的回复
拖慢，而这条通路一旦不可用，召回只是降级成字面档，不该连插件一起下线。

模型：`Xenova/bge-small-zh-v1.5`，ONNX **q8** 单精度量化版，输出 512 维、L2 归一化。
fp32（94.9MB）不进项目资产，只保 q8（24,010,842B）。

## 安装

```bash
cd embed-service
./install.sh
```

装两件东西：依赖（`onnxruntime-web@1.17.3` + `@huggingface/tokenizers@0.2.0`，版本锁死）
和权重（下到 `./model/`，按 size + sha256 校验）。可重入：已校验过的文件直接跳过。

国内网络的两条既定事实（不是抖动，别反复重试）：

- `huggingface.co` 不可达 → 默认走 `https://hf-mirror.com`。换源用
  `AKANE_EMBED_MIRROR=<url>`；要过代理就按 curl/npm 都认的 `HTTPS_PROXY` / `https_proxy` 走。
- npm 想加速用 `AKANE_EMBED_NPM_REGISTRY=<镜像源>`。
- 权重目录想换地方：`AKANE_EMBED_MODEL_DIR=<路径>`（install.sh 与 `node server.mjs` 都读它，
  也可以用 `--model-dir` 显式传）。

装完脚本会自动跑下面两个自检，任一失败即非零退出。

## 启动与停止（归用户）

插件**不 spawn、不自愈、不 kill** 这个进程。启停由你负责：

```bash
cd embed-service
setsid nohup node server.mjs > ~/.akane-embed.log 2>&1 < /dev/null &   # 起
kill "$(pgrep -f 'embed-service/server.mjs')"                            # 停
```

- 默认 `127.0.0.1:8765`；`--port 9000` 或 `AKANE_EMBED_PORT=9000` 改端口。
- **只绑回环，`HOST` 连配置都不读**。送进 `/embed` 的就是聊天正文，绑 `0.0.0.0`
  等于把这个接口开放给整栋楼。改端口可以，改监听地址不行。
- `AKANE_EMBED_THREADS` 调 WASM 线程数，默认 1（本机单线程已经够用：见下面「实测数字」）。
- 日志只打批次条数、维度、耗时、RSS —— 正文一个字符都不写。

## 接口

```
GET  /health  →  {"ok":true,"model":"Xenova/bge-small-zh-v1.5","dims":512}
POST /embed   →  入参 {"texts":["…","…"]}
                 出参 {"ok":true,"model":"…","dims":512,"vectors":[[…512 个 float…],…]}
```

`vectors` 与 `texts` **同序等长**（索引侧靠这个对齐写 `vectors.f32.bin`）。
守住的几条：单批 ≤64 条（超出 400）、请求体 ≤4MB（超出即断开）、`texts` 必须是非空的
字符串数组（否则 400）；单条超过 4000 字符是**截断处理**而不是报错。其他路径一律 404
（不提供任何「顺手」的能力），推理抛异常回 500 `INFERENCE_FAILED` 且日志只留错误类别。

## 自检

```bash
node verify-tokenizer.mjs   # 349 条分词与 HF 参考实现对拍，必须 0 错
node selftest.mjs           # 相关句对 vs 无关句对，必须 minRelated > maxUnrelated
```

`verify-tokenizer.mjs` 是整条索引的地基守卫：**分词必须与建索引时同一实现**，
否则余弦没有意义。手写 WordPiece 在同一批对拍里 349 条错 202 条（ASCII 标点、英文
大小写、空白、码点 >64k 全错），所以这里用官方纯 JS `@huggingface/tokenizers`
（同一批 0 错）。升级 onnxruntime / tokenizers、换模型、动权重，都要先跑它。

## 实测数字（11-19，本机单线程 q8）

| 项 | 实测 |
| --- | --- |
| 载入 | `loadMs` 644–691 |
| 冷启动后 RSS | 229–435 MB（两次冷启动的区间，别当恒定值） |
| 单批嵌入 | batch=1 19ms，batch=2 30–77ms，batch=8 120ms |
| 向量 | 512 维，‖v‖=1 |

**已知限制：q8 的余弦随批量形状漂移 ±0.01。** 同一条文本 batch=1 与 batch=8 的向量
自相似 0.995351；同一句对 batch=2 得 0.7457、batch=8 得 0.7562。所以阈值不许贴着
某个分数定，也不许拿 cos≈0.99 当「重复内容」判据。

## 与插件的契约

插件侧 `config.memory.embedBaseUrl` 必须指回环地址，`src/memory/embed-client.ts`
对非回环直接拒绝（连请求都不发）。服务不可达时：回填跳过这一轮（不重试轰炸），
召回降级成只走字面档并在返回体里写明。**不存在**降级到远程 embedding API 的路径。

`model/` 与 `node_modules/` 都进了 `.gitignore`——权重不进 git，装机靠 `install.sh`。
