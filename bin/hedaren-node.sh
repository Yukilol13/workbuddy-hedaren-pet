#!/bin/sh
# ===================================================================
#  和大人桌宠 · node 运行时包装（macOS / Linux）
#  每次执行时才去找 node，绝不写死版本号。
#  顺序：HEDAREN_NODE_EXE -> WorkBuddy current 指针 -> versions 下最新
#        -> PATH 里的 node -> 项目自带 Electron（当 node 用）
#  用法：./hedaren-node.sh <脚本路径> [参数...]
# ===================================================================
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WBROOT="$HOME/.workbuddy/binaries/node/versions"
N=""

if [ -n "$HEDAREN_NODE_EXE" ] && [ -x "$HEDAREN_NODE_EXE" ]; then
  N="$HEDAREN_NODE_EXE"
fi

if [ -z "$N" ] && [ -f "$WBROOT/current" ]; then
  VER=$(cat "$WBROOT/current" 2>/dev/null | tr -d ' \r\n')
  if [ -n "$VER" ] && [ -x "$WBROOT/$VER/bin/node" ]; then
    N="$WBROOT/$VER/bin/node"
  fi
fi

if [ -z "$N" ]; then
  for d in "$WBROOT"/*; do
    if [ -x "$d/bin/node" ]; then N="$d/bin/node"; fi
  done
fi

if [ -z "$N" ] && command -v node >/dev/null 2>&1; then
  N=$(command -v node)
fi

if [ -n "$N" ]; then
  exec "$N" "$@"
fi

if [ -x "$HERE/../vendor/electron/electron" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$HERE/../vendor/electron/electron" "$@"
fi

echo "[hedaren] 没找到 node 运行时：WorkBuddy 未安装，或 node 目录被清掉了。" >&2
echo "[hedaren] 请先装好 WorkBuddy，再重跑 install.js。" >&2
exit 127
