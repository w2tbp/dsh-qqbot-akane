#!/bin/sh
# @akane/dsh-qqbot 一键安装（dsh-qqbot 本地 fork）
#
# 走 dsh CLI 的 profile 插件机制：`add` 自动初始化 profile（首层
# dsh-base），pnpm 安装后按 dsh.bundle.patch 元数据把本包追加为 bundle 层。
# 无需 DSH 源码，无需 workspace 链接。
#
# 插件装完后会把包内 skills/ 复制到 $DSH_HOME/skills（默认 ~/.dsh/skills），
# 那是宿主运行时扫描技能的位置，改完不需要重启进程。
#
# 用法：
#   sh install.sh                                            # 安装默认包最新版本
#   sh install.sh --version 0.2.0                            # 指定版本
#   sh install.sh --pkg @myorg/my-plugin                     # 指定包名
#   sh install.sh --pkg @myorg/my-plugin --version 1.0.0     # 指定包名+版本
#   sh install.sh --registry https://registry.npmmirror.com  # 指定 npm registry
set -eu

# ── 默认值 ──
PACKAGE="@akane/dsh-qqbot"
VERSION=""
REGISTRY=""
PROFILE="qqbot"

# ── 参数解析 ──
while [ $# -gt 0 ]; do
  case "$1" in
    --pkg)
      shift; PACKAGE="$1" ;;
    --pkg=*)
      PACKAGE="${1#--pkg=}" ;;
    --version)
      shift; VERSION="$1" ;;
    --version=*)
      VERSION="${1#--version=}" ;;
    --registry)
      shift; REGISTRY="$1" ;;
    --registry=*)
      REGISTRY="${1#--registry=}" ;;
    --profile)
      shift; PROFILE="$1" ;;
    --profile=*)
      PROFILE="${1#--profile=}" ;;
    -h|--help)
      echo "用法: sh install.sh [选项]"
      echo
      echo "选项:"
      echo "  --pkg <name>        指定 npm 包名 (默认: @akane/dsh-qqbot)"
      echo "  --version <ver>     指定包版本 (默认: latest)"
      echo "  --registry <url>    指定 npm registry"
      echo "  --profile <name>    指定 dsh profile 名 (默认: qqbot)"
      echo "  -h, --help          显示帮助"
      exit 0
      ;;
    *)
      echo "未知参数: $1 (使用 --help 查看用法)" >&2
      exit 1
      ;;
  esac
  shift
done

# ── 预检 ──
if ! command -v dsh >/dev/null 2>&1; then
  echo "未检测到 dsh CLI。先安装：" >&2
  echo "  npm install -g @deepseek-ai/dsh" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "未检测到 pnpm。dsh plugin 依赖 pnpm，请先安装：" >&2
  echo "  npm install -g pnpm" >&2
  exit 1
fi

# ── 构造安装标识 ──
INSTALL_SPEC="$PACKAGE"
if [ -n "$VERSION" ]; then
  INSTALL_SPEC="${PACKAGE}@${VERSION}"
fi

REGISTRY_ARG=""
if [ -n "$REGISTRY" ]; then
  REGISTRY_ARG="--registry ${REGISTRY}"
fi

# ── 安装 ──
echo "=================================================="
echo "  安装 QQ Bot 插件到 dsh"
echo "=================================================="
echo
echo "  包名:     ${INSTALL_SPEC}"
echo "  Profile:  ${PROFILE}"
[ -n "$REGISTRY" ] && echo "  Registry: ${REGISTRY}"
echo

dsh plugin --profile "$PROFILE" add "$INSTALL_SPEC" $REGISTRY_ARG

# ── 安装 skills ──
# 包内 skills/ 是行为规范的唯一载体（表情包库的存取规矩等）。宿主运行时扫描
# $DSH_HOME/skills，装完下一轮即生效，不需要重启进程。
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_SRC_DIR="$SCRIPT_DIR/skills"

if [ -d "$SKILL_SRC_DIR" ]; then
  mkdir -p "$DSH_HOME_DIR/skills"
  for entry in "$SKILL_SRC_DIR"/*/; do
    [ -d "$entry" ] || continue
    name="$(basename "$entry")"
    dest="$DSH_HOME_DIR/skills/$name"
    # 目标已存在且内容不同：说明用户可能手改过，备份后再覆盖，不静默丢改动。
    # 备份必须落在 skills/ 之外——宿主按目录扫描技能，留在里面会被当成
    # 第二个同名 skill 读进 available_skills。
    if [ -d "$dest" ] && ! diff -rq "$entry" "$dest" >/dev/null 2>&1; then
      backup_dir="$DSH_HOME_DIR/skills-backup"
      mkdir -p "$backup_dir"
      backup="$backup_dir/$name.bak-$(date +%Y%m%d-%H%M%S)"
      mv "$dest" "$backup"
      echo "  skill $name: 旧版本已备份到 $backup"
    fi
    mkdir -p "$dest"
    cp -R "$entry"/. "$dest"/
    echo "  skill $name → $dest"
  done
fi

echo
echo "=================================================="
echo "  安装完成"
echo "=================================================="
echo
echo "配置环境变量："
echo "  export QQBOT_APPID=\"你的AppID\""
echo "  export QQBOT_SECRET=\"你的AppSecret\""
echo "  export DEEPSEEK_API_KEY=\"你的API Key\""
echo
echo "启动："
echo "  dsh --profile ${PROFILE}"
echo
