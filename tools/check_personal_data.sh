#!/usr/bin/env bash
# 個人情報や機体固有 MAC が公開ドキュメント／ソースに残っていないかチェック
# CI 等で実行することを想定。1件でも見つかったら exit 1。

set -e
cd "$(dirname "$0")/.."

# 検索パターン
patterns=(
  "C:\\\\Users\\\\20051"
  "94:A9:90:6D:52:50"
  "58:8C:81:AE:E0:60"
)

# 除外パス
exclude_dirs=(
  "node_modules"
  ".next"
  ".venv"
  "__pycache__"
  ".git"
  "tools"
)

exclude_args=()
for d in "${exclude_dirs[@]}"; do
  exclude_args+=("--exclude-dir=$d")
done

found=0
for p in "${patterns[@]}"; do
  if grep -RIn "${exclude_args[@]}" -- "$p" . > /dev/null 2>&1; then
    echo "❌ found personal data: $p"
    grep -RIn "${exclude_args[@]}" -- "$p" .
    found=1
  fi
done

if [ "$found" -ne 0 ]; then
  echo "個人情報が含まれています。配布前に削除してください。"
  exit 1
fi

echo "✅ no personal data found"
