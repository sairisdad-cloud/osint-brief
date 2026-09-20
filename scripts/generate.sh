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

# 生成と検証。まれにモデルがツール呼び出しを試みて出力が壊れるため、
# 検証に落ちたら1回だけ再試行する。
generate_once() {
  # 初回投稿用の追加指示があれば挟む(投稿成功後にrun_daily.shがリネームして外す)
  FIRST_POST="$ROOT/prompts/first-post.md"
  {
    /bin/cat "$PROMPT"
    if [ -f "$FIRST_POST" ]; then
      /bin/cat "$FIRST_POST"
    fi
    /bin/echo ""
    /bin/echo "以下が材料テキストです。"
    /bin/echo "----------------------------------------"
    /bin/cat "$DIGEST"
  } | "$CLAUDE_BIN" -p \
    --tools "" \
    --strict-mcp-config \
    --permission-mode dontAsk \
    > "$OUT"
}

validate() {
  # 空でないこと
  [ -s "$OUT" ] || { echo "検証NG: 出力が空" >&2; return 1; }
  # 1行目がタイトル形式であること
  /usr/bin/head -1 "$OUT" | /usr/bin/grep -q "世界情勢ブリーフ" \
    || { echo "検証NG: 1行目がタイトル形式でない" >&2; return 1; }
  # ツール呼び出しの残骸が混入していないこと
  if /usr/bin/grep -q "<invoke\|<function" "$OUT"; then
    echo "検証NG: ツール呼び出しタグが混入" >&2
    return 1
  fi
  # 最低限の分量(3000バイト)があること
  [ "$(/usr/bin/wc -c < "$OUT" | /usr/bin/tr -d ' ')" -ge 3000 ] \
    || { echo "検証NG: 出力が短すぎる" >&2; return 1; }
  return 0
}

generate_once
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo "エラー: claude -p が終了コード $STATUS で失敗しました" >&2
  exit $STATUS
fi

if ! validate; then
  echo "1回目の出力が不正のため再試行します" >&2
  generate_once
  STATUS=$?
  if [ $STATUS -ne 0 ]; then
    echo "エラー: 再試行の claude -p が終了コード $STATUS で失敗しました" >&2
    exit $STATUS
  fi
  if ! validate; then
    echo "エラー: 再試行でも出力が不正です ($OUT)" >&2
    exit 1
  fi
fi

# 言語制約の機械チェック: 簡体字・ハングルが混入していたら異常終了
if /usr/bin/perl -ne 'exit 1 if /[\x{AC00}-\x{D7AF}\x{3130}-\x{318F}]/' "$OUT"; then
  :
else
  echo "エラー: 生成記事にハングルが混入しています" >&2
  exit 1
fi

echo "記事を生成しました: $OUT ($(wc -c < "$OUT" | tr -d ' ') バイト)"
