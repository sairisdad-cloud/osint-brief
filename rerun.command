#!/bin/bash
# rerun.command: 欠報時にFinderからダブルクリックで再実行するためのラッパー。
cd "$(dirname "$0")" || exit 1
/bin/bash ./run_daily.sh
echo ""
echo "再実行が終了しました。結果は通知と logs/ を確認してください。"
read -r -p "Enterキーで閉じます..."
