#!/usr/bin/env bash
# fork 侵入面报告：只看「改了上游文件」的那部分，新增文件不算（它们合并不产生冲突）。
# 用法：scripts/fork-diff.sh [上游基线，默认 0.5.5]
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-0.5.5}"
cd_src() { git diff "$@" -- src; }

invasion=$(cd_src --numstat --diff-filter=M "$BASE"..HEAD | grep -v '\.test\.ts$' || true)
newfiles=$(cd_src --name-only --diff-filter=A "$BASE"..HEAD | grep -v '\.test\.ts$' || true)

echo "基线：$BASE  当前：$(git rev-parse --short HEAD)  分支：$(git branch --show-current)"
echo
echo "== 侵入的上游文件（合并时会产生冲突）=="
[ -n "$invasion" ] && echo "$invasion" | awk -F'\t' '{printf "  %-46s +%s -%s\n", $3, $1, $2}' | sort -t+ -k2 -rn || echo "  （无）"
echo
echo "== fork 自有新文件（零合并成本）=="
[ -n "$newfiles" ] && echo "$newfiles" | sed 's/^/  /' || echo "  （无）"
echo
echo "== 守卫 =="
printf '%s\n' "$invasion" | sed '/^$/d' | wc -l | xargs -I{} echo "  侵入文件 {} 个；这些文件的钩子由 src/fork-guard.test.ts 断言，合并后必须 pnpm test 全绿"
echo "  lib/ 冲突不要手工解，重跑 pnpm build 覆盖即可"
