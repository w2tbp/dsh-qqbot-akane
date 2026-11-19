#!/usr/bin/env bash
# embed-service 装机脚本 —— 依赖 + 权重，一次跑完。
#
# 两条国内网络的现实（MEMORY.md §3 的环境事实，别当成网络抖动）：
#   - **huggingface.co 不可达**，所以下载默认走 hf-mirror.com（可用 AKANE_EMBED_MIRROR 覆盖）。
#     要过代理就按 curl/npm 都认的环境变量走：HTTPS_PROXY / https_proxy。
#   - npm registry 可达；国内加速用 AKANE_EMBED_NPM_REGISTRY 指镜像源。
# 装不上时先 `npm config get registry`、`curl -sI "$AKANE_EMBED_MIRROR"` 各看一眼。
#
# 用法：
#   ./install.sh                                  # 默认装到 ./model
#   AKANE_EMBED_MODEL_DIR=/path ./install.sh      # 权重放别处
#   HTTPS_PROXY=http://127.0.0.1:7890 ./install.sh
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT=$(pwd)
MODEL_DIR=${AKANE_EMBED_MODEL_DIR:-$REPO_ROOT/model}
MIRROR=${AKANE_EMBED_MIRROR:-https://hf-mirror.com}
NPM_REGISTRY=${AKANE_EMBED_NPM_REGISTRY:-}
REVISION=${AKANE_EMBED_REVISION:-75c43b069aac4d136ba6bc1122f995fedcfd2781}
REPO_ID=Xenova/bge-small-zh-v1.5

# 路径 → sha256（blobs 按内容寻址，校验值就是文件身份；11-19 实测抓的）
FILES=(
  "tokenizer.json|439125|48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26"
  "tokenizer_config.json|367|e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a"
  "config.json|716|d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f"
  "special_tokens_map.json|125|b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3"
  # 只保 q8（24,010,842B）；fp32 94.9MB 不进项目资产
  "model_quantized.onnx|24010842|15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc"
)

log() { printf '[akane-embed-install] %s\n' "$*"; }

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

# ── 1. 依赖：两个都锁死到实测过的那两个版本 ──────────────────────────
# onnxruntime-web@1.17.3：1.26 的 postinstall 取预编译 build list 会 302 后失败（§3 环境事实）
# @huggingface/tokenizers@0.2.0：分词对拍就是在这个版本上 0/349 通过的，换版必重跑
#   verify-tokenizer.mjs
log "npm install（onnxruntime-web@1.17.3 + @huggingface/tokenizers@0.2.0）"
if [ -n "$NPM_REGISTRY" ]; then
  npm install --registry "$NPM_REGISTRY" --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

# ── 2. 权重：缓存优先，其次镜像；两份都要校验 sha256 ──────────────────
mkdir -p "$MODEL_DIR"
CACHE_ROOT=${HF_HOME:-$HOME/.cache/huggingface}/hub/models--${REPO_ID//\//--}

for entry in "${FILES[@]}"; do
  IFS='|' read -r name size want <<<"$entry"
  target="$MODEL_DIR/$name"

  if [ -f "$target" ] && [ "$(sha_of "$target")" = "$want" ]; then
    log "$name 已就位且校验通过"
    continue
  fi

  # 缓存里的文件是符号链接，cp -L 解成实文件 —— 直接 cp 会拷成断链
  candidate=$(find "$CACHE_ROOT/snapshots" -name "$(basename "$name")" -type l 2>/dev/null | head -n1 || true)
  if [ -n "$candidate" ] && [ "$(sha_of "$candidate")" = "$want" ]; then
    log "$name 取自本地 HF 缓存 $candidate"
    cp -L "$candidate" "$target"
    continue
  fi

  remote_path=$name
  [ "$name" = "model_quantized.onnx" ] && remote_path=onnx/model_quantized.onnx
  url="$MIRROR/$REPO_ID/resolve/$REVISION/$remote_path"
  log "$name 本地没有 → 从镜像取 $url"
  curl --fail --location --retry 3 --progress-bar -o "$target.part" "$url"

  if [ "$(stat -c%s "$target.part")" != "$size" ]; then
    log "$name 大小不符（期望 $size，得到 $(stat -c%s "$target.part")）—— 删除，请检查代理/镜像"
    rm -f "$target.part"
    exit 1
  fi
  if [ "$(sha_of "$target.part")" != "$want" ]; then
    log "$name sha256 不符 → 拒绝入位（镜像内容被改过？先别用）"
    rm -f "$target.part"
    exit 1
  fi
  mv "$target.part" "$target"
  log "$name 校验通过"
done

# ── 3. 自检：分词对拍 + 运行时冒烟，都不起端口 ───────────────────────
log "verify-tokenizer.mjs"
AKANE_EMBED_MODEL_DIR="$MODEL_DIR" node verify-tokenizer.mjs
log "selftest.mjs"
AKANE_EMBED_MODEL_DIR="$MODEL_DIR" node selftest.mjs

log "完成。启动常驻服务（由你负责启停，插件不 spawn 也不 kill）："
log "  node $REPO_ROOT/server.mjs --port 8765 --model-dir $MODEL_DIR"
log "只绑 127.0.0.1；内存预算按 ~320MB 记。"
