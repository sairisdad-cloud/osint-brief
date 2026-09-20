#!/bin/bash
# generate.sh: work/digest.txt を材料に claude -p で記事Markdownを生成し
# work/article.md に出力する。
# ツールは --tools "" で全面無効化し、--strict-mcp-config でMCPサーバーも
# 一切ロードしないため、無人実行時に承認ダイアログは構造的に発生しない。
# --bare は使わない(ベアモードはMaxプランのOAuth認証を読み込まずAPIキー課金に
# なるため。公式ヘッドレス文書で確認済み)。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_BIN="/Users/tsugihitominagawa/.local/bin/claude"
DIGEST="$ROOT/work/digest.txt"
PROMPT="$ROOT/prompts/article.md"
OUT="$ROOT/work/article.md"

if [ ! -s "$DIGEST" ]; then
  echo "エラー: $DIGEST がないか空です。先に collect.mjs を実行してください" >&2
  exit 1
fi

/bin/cat "$PROMPT" "$DIGEST" | "$CLAUDE_BIN" -p \
  --tools "" \
  --strict-mcp-config \
  --permission-mode dontAsk \
  > "$OUT"
STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo "エラー: claude -p が終了コード $STATUS で失敗しました" >&2
  exit $STATUS
fi

if [ ! -s "$OUT" ]; then
  echo "エラー: 記事出力が空です ($OUT)" >&2
  exit 1
fi

# 言語制約の機械チェック: 簡体字・ハングルが混入していたら異常終了
if /usr/bin/perl -ne 'exit 1 if /[\x{AC00}-\x{D7AF}\x{3130}-\x{318F}]/' "$OUT"; then
  :
else
  echo "エラー: 生成記事にハングルが混入しています" >&2
  exit 1
fi

echo "記事を生成しました: $OUT ($(wc -c < "$OUT" | tr -d ' ') バイト)"
