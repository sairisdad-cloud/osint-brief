#!/bin/bash
# run_daily.sh: 毎朝launchdから起動される本体。
# RSS収集 -> 記事生成 -> はてな下書き投稿 を順に実行し、
# ログを logs/YYYY-MM-DD.log に保存、成否をmacOS通知で知らせる。
# launchdはPATHが最小のため、コマンドはすべて絶対パスで書く。
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="/Users/tsugihitominagawa/.local/bin/node"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/$(/bin/date +%Y-%m-%d).log"
/bin/mkdir -p "$LOG_DIR" "$ROOT/work"

# 8:00の別タスク(morning-domain-watch)が動くまでスリープさせない。
# 現在時刻から8:05までの秒数を計算してcaffeinateをバックグラウンド起動する。
NOW_SEC=$(( $(/bin/date +%H) * 3600 + $(/bin/date +%M) * 60 ))
TARGET_SEC=$(( 8 * 3600 + 5 * 60 ))
HOLD_SEC=$(( TARGET_SEC - NOW_SEC ))
if [ $HOLD_SEC -lt 1800 ]; then
  HOLD_SEC=1800
fi
/usr/bin/caffeinate -i -t $HOLD_SEC &

notify() {
  /usr/bin/osascript -e "display notification \"$2\" with title \"$1\"" || true
}

fail() {
  echo "[$(/bin/date '+%H:%M:%S')] 失敗: $1" >> "$LOG_FILE"
  notify "世界情勢ブリーフ 失敗" "$1 ログ: logs/$(/bin/date +%Y-%m-%d).log"
  exit 1
}

{
  echo "===== 実行開始 $(/bin/date '+%Y-%m-%d %H:%M:%S') ====="
} >> "$LOG_FILE"

echo "[$(/bin/date '+%H:%M:%S')] RSS収集を開始" >> "$LOG_FILE"
"$NODE_BIN" "$ROOT/scripts/collect.mjs" >> "$LOG_FILE" 2>&1 \
  || fail "RSS収集でエラー。"

echo "[$(/bin/date '+%H:%M:%S')] 記事生成を開始" >> "$LOG_FILE"
/bin/bash "$ROOT/scripts/generate.sh" >> "$LOG_FILE" 2>&1 \
  || fail "記事生成でエラー。"

echo "[$(/bin/date '+%H:%M:%S')] はてな下書き投稿を開始" >> "$LOG_FILE"
"$NODE_BIN" "$ROOT/scripts/post_hatena.mjs" >> "$LOG_FILE" 2>&1 \
  || fail "はてな投稿でエラー。"

echo "[$(/bin/date '+%H:%M:%S')] 全工程成功" >> "$LOG_FILE"
notify "世界情勢ブリーフ" "下書き作成完了。はてな管理画面で確認できます"
