#!/bin/bash
# generate.sh: work/digest.txt から記事を作り work/article.md に書く。
# 以前は claude -p を使っていたが、組織設定で Claude Code の
# サブスクリプション利用が止まったため、Gemini API で生成する。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="/Users/tsugihitominagawa/.local/bin/node"

exec "$NODE_BIN" "$ROOT/scripts/generate.mjs"
