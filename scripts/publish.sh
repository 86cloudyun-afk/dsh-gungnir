#!/usr/bin/env bash
# 一键发布/恢复线上：绑定任意 GitHub 账号后跑本脚本即可。
# 用法：gh auth login 之后，REPO_NAME=dsh-gungnir scripts/publish.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_NAME="${REPO_NAME:-dsh-gungnir}"
OWNER="$(gh api user --jq .login)"
FULL="${OWNER}/${REPO_NAME}"

echo "[*] 账号: ${OWNER}  仓库: ${FULL}"

# 仓库不存在则创建（已存在则直接复用）
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "https://github.com/${FULL}.git"
  git push -u origin main
elif ! gh repo view "$FULL" >/dev/null 2>&1; then
  gh repo create "$REPO_NAME" --public --source=. --remote=origin --push \
    --description "GUNGNIR - DSH 红队战役指挥框架：攻击路径合成的工程化。事实库+门闸+跳板池，执行层可插拔。编排层，不含漏洞利用代码；仅限授权测试。"
else
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/${FULL}.git"
  git push -u origin main
fi

# topics
gh repo edit "$FULL" --add-topic dsh-plugin --add-topic redteam --add-topic multi-agent \
  --add-topic penetration-testing --add-topic deepseek-harness --add-topic sqlite

# 冻结 tag（幂等：已有则跳过）
TAG="v0.1.0-alpha.1"
if ! git rev-parse "$TAG" >/dev/null 2>&1; then git tag "$TAG"; fi
git push origin "$TAG" 2>/dev/null || true

echo "[✓] 线上恢复完成: https://github.com/${FULL}"
