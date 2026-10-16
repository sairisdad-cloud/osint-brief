#!/bin/bash
# record_run.sh: record/inbox の主張を1件、The Record の下書きにする。
# 世界情勢ブリーフの毎朝の処理とは別。届いたときに手で実行する。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="/Users/tsugihitominagawa/.local/bin/node"

exec "$NODE_BIN" "$ROOT/scripts/record_run.mjs" "$@"
