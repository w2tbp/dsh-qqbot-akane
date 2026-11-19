#!/usr/bin/env bash
# akane 常驻 embedding 服务的停机脚本（Linux / macOS）—— 与 stop.ps1 同语义。
#
# 唯一的安全线：**按命令行特征找人**（`server.mjs --port <这个端口>`），绝不做全局 node 匹配。
# 现网的 `dsh web` 同样是 node 进程，`pkill node` 一类写法会把她整个下线。
# pid 文件只是提示，不作为依据 —— 写错或过期的 pid 会杀到别人头上，所以每个候选都要过命令行核对。
#
# 用法：
#   ./stop.sh                  # 停默认 8765 上那个
#   ./stop.sh --port 9000
set -euo pipefail

port=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port | -p)
      port=${2:-}
      [ -n "$port" ] || { echo "[akane-embed] --port 需要值" >&2; exit 2; }
      shift 2
      ;;
    -h | --help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *)
      echo "[akane-embed] 未知参数：$1（--port / --help）" >&2
      exit 2
      ;;
  esac
done

port=${port:-${AKANE_EMBED_PORT:-8765}}
case "$port" in
  '' | *[!0-9]*) echo "[akane-embed] 端口非法：$port（需要 1-65535 的整数）" >&2; exit 2 ;;
esac

pidFile=$HOME/.akane-embed.pid
pattern="server.mjs --port $port"

# 候选 = pid 文件里那个 + 命令行特征命中的那些，逐个再用特征核对一遍才动手。
# 尾上的 `|| true` 不是吞错：没在服务时 grep 必然回 1，那正是本脚本的正常路径。
candidates=$(
  {
    [ -r "$pidFile" ] && cat "$pidFile"
    ps -eo pid,args | awk -v pat="$pattern" '$0 ~ pat && !/awk/ {print $1}'
  } 2>/dev/null | tr -d ' ' | { grep -E '^[0-9]+$' || true; } | sort -u
) || true

if [ -z "$candidates" ]; then
  echo "[akane-embed] 没找到 --port $port 的服务进程，不动任何进程"
  exit 0
fi

killed=0
for pid in $candidates; do
  [ "$pid" = "$$" ] && continue
  args=$(ps -o args= -p "$pid" 2>/dev/null || true)
  case "$args" in
    *server.mjs*"$port"*) ;;
    *)
      # pid 文件过期后这个号可能已经被别人占用 —— 认不出来就绝不碰。
      echo "[akane-embed] 跳过 pid=$pid：命令行不含 server.mjs --port $port，不是本服务"
      continue
      ;;
  esac
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    ps -p "$pid" >/dev/null 2>&1 || break
    sleep 1
  done
  if ps -p "$pid" >/dev/null 2>&1; then
    echo "[akane-embed] pid=$pid TERM 后 10s 没退，保留它 —— 需要更强信号请你自己确认后再动手"
  else
    echo "[akane-embed] 已停 pid=$pid"
    killed=$((killed + 1))
  fi
done

[ -e "$pidFile" ] && rm -f "$pidFile"
echo "[akane-embed] 共停 $killed 个进程（端口 $port）"
