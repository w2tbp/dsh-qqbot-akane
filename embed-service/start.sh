#!/usr/bin/env bash
# akane 常驻 embedding 服务的启动器（Linux / macOS）—— 与 start.ps1 同语义。
#
# 为什么要它：此前 POSIX 侧只有 install.sh，启停全靠文档里那条
# `setsid nohup node server.mjs > ~/.akane-embed.log 2>&1 < /dev/null &` 手敲。
# 手敲的代价是每次都得自己确认两件事：8765 上是不是已经有进程、这次到底起没起成。
# 这里把三件事固定下来：已有服务就不重复起、pid 落盘、轮询 /health 到真能用为止。
#
# 用法：
#   ./start.sh                     # 默认 8765
#   ./start.sh --port 9000
#   ./start.sh --model-dir ~/akane-model
#
# 运行时前提只有 Node ≥22。本脚本不装依赖也不取权重（那归 install.sh / install.mjs）。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
port=""
model_dir=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port | -p)
      port=${2:-}
      [ -n "$port" ] || { echo "[akane-embed] --port 需要值" >&2; exit 2; }
      shift 2
      ;;
    --model-dir)
      model_dir=${2:-}
      [ -n "$model_dir" ] || { echo "[akane-embed] --model-dir 需要值" >&2; exit 2; }
      shift 2
      ;;
    -h | --help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "[akane-embed] 未知参数：$1（--port / --model-dir / --help）" >&2
      exit 2
      ;;
  esac
done

port=${port:-${AKANE_EMBED_PORT:-8765}}
case "$port" in
  '' | *[!0-9]*) echo "[akane-embed] 端口非法：$port（需要 1-65535 的整数）" >&2; exit 2 ;;
esac

log=$HOME/.akane-embed.log
errLog=$HOME/.akane-embed.err.log
pidFile=$HOME/.akane-embed.pid
health="http://127.0.0.1:$port/health"

command -v node >/dev/null 2>&1 || { echo "[akane-embed] 找不到 node（需要 Node ≥22）" >&2; exit 1; }

# 已经在跑就不重复起 —— 两个进程抢同一端口时，第二个直接 EADDRINUSE 崩掉，
# 而现场看起来像「服务起不来」，其实是我们自己多起了一个。
if alive=$(curl -fsS -m 2 "$health" 2>/dev/null); then
  echo "[akane-embed] $port 上已经有服务在跑：$alive"
  echo "[akane-embed] 要换代码生效请用 ./stop.sh 再 ./start.sh"
  exit 0
fi

args=("$here/server.mjs" --port "$port")
[ -n "$model_dir" ] && args+=(--model-dir "$model_dir")

: >>"$log"
: >>"$errLog"

# setsid 让服务脱离本脚本的进程组，脚本退出后服务不被带走；macOS 没有 setsid 就退回 nohup。
if command -v setsid >/dev/null 2>&1; then
  setsid nohup node "${args[@]}" >>"$log" 2>>"$errLog" < /dev/null &
else
  nohup node "${args[@]}" >>"$log" 2>>"$errLog" < /dev/null &
fi
launched=$!
disown 2>/dev/null || true

# 载入权重实测 644–691ms（q8 单线程），但冷启动机器慢时会更久，给 30 秒。
for _ in $(seq 1 30); do
  if reply=$(curl -fsS -m 2 "$health" 2>/dev/null); then
    # pid 不认 $! —— setsid 会换进程号，写错的 pid 只会让 stop.sh 找不到人或杀错人。
    # 认「命令行里有 server.mjs --port <这个端口>」，这是唯一不会牵连 dsh web 的特征。
    pid=$(ps -eo pid,args | awk -v pat="server.mjs --port $port" '$0 ~ pat && !/awk/ {print $1; exit}')
    [ -n "$pid" ] && echo "$pid" >"$pidFile"
    echo "[akane-embed] ready：$reply"
    echo "[akane-embed] pid=${pid:-未取到} 日志=$log（日志只有条数/维度/毫秒，正文一个字符都不写）"
    echo "[akane-embed] 停机：./stop.sh"
    exit 0
  fi
  sleep 1
done

echo "[akane-embed] 30s 内 /health 没答。进程可能还在载入 —— 查 $errLog 与 $log"
echo "[akane-embed] 若确认起不来，清理：kill ${launched}"
exit 1
