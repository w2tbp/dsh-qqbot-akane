#!/usr/bin/env bash
# 兼容入口 —— 真正的内容在同目录的 install.mjs（三平台同一份，不依赖 curl / sha256sum / find）。
#
# 为什么还留着这个文件：现网文档与 AGENTS.md 都写的是 `./install.sh`，Linux/macOS 上
# 大家也习惯这么敲。参数原样透传，环境变量（AKANE_EMBED_MIRROR / AKANE_EMBED_NPM_REGISTRY /
# AKANE_EMBED_MODEL_DIR / AKANE_EMBED_REVISION / HTTPS_PROXY）由 install.mjs 读。
#
# Windows 上没有 bash 也能装：`node install.mjs`，或用 start.ps1 / stop.ps1 管常驻服务。
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/install.mjs" "$@"
