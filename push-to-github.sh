#!/usr/bin/env bash
#
# 一条命令完成推送：认证自检 -> 建仓库（若不存在）-> 推送 main -> 打印链接。
#
# 为什么要这个脚本，而不是照抄 dsh-survival-mode 的那个：
#   那个脚本走 `git@github-dsh` 这个 SSH 别名。本机实测**那条路是不通的**
#   （`Permission denied (publickey)`——~/.ssh/id_ed25519_github_dsh 没有注册到
#   目标 GitHub 账号）。本仓库改用 **HTTPS**，凭据由 macOS keychain 提供，
#   已实测可用。脚本同时保留 SSH 分支，方便你以后把 key 补上。
#
# 用法：
#   ./push-to-github.sh                       # 用默认仓库名推送
#   ./push-to-github.sh dsh-other-name        # 指定仓库名
#
set -euo pipefail

REPO_NAME="${1:-dsh-computer-use-turbo}"
SSH_HOST_ALIAS="${GITHUB_SSH_ALIAS:-github-dsh}"

say() { printf '%s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
say "==> 1/5 确认在仓库根目录"
[ -d .git ] || die "当前目录不是 git 仓库（请在 dsh-computer-use-turbo/ 下运行）"
git rev-parse --verify HEAD >/dev/null 2>&1 || die "还没有任何提交，先 git add + git commit"
[ -z "$(git status --porcelain)" ] || say "    提示：工作区有未提交改动，本次不会包含它们"

# ---------------------------------------------------------------------------
say "==> 2/5 探测可用的认证方式"
AUTH=""
if ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -T "git@${SSH_HOST_ALIAS}" 2>&1 \
   | grep -q "successfully authenticated"; then
  AUTH="ssh"
  say "    SSH 可用（别名 git@${SSH_HOST_ALIAS}）"
elif printf 'protocol=https\nhost=github.com\n\n' | git credential-osxkeychain get 2>/dev/null | grep -q '^password='; then
  AUTH="https"
  say "    HTTPS 可用（macOS keychain 里有 github.com 凭据）"
else
  die "两种认证都不可用。请任选其一：
     a) 把公钥加到 GitHub：https://github.com/settings/keys
        并确认 ~/.ssh/config 里有 Host ${SSH_HOST_ALIAS} 指向 github.com
     b) 让 git 记住一个 HTTPS 凭据：
        printf 'protocol=https\\nhost=github.com\\n\\n' | git credential-osxkeychain store"
fi

# ---------------------------------------------------------------------------
say "==> 3/5 确定账号"
if [ "$AUTH" = "ssh" ]; then
  USERNAME=$(ssh -T "git@${SSH_HOST_ALIAS}" 2>&1 | sed -n 's/^Hi \([^!]*\)!.*/\1/p')
  [ -n "$USERNAME" ] || die "SSH 通过了但解析不出账号名"
else
  PW=$(printf 'protocol=https\nhost=github.com\n\n' | git credential-osxkeychain get | sed -n 's/^password=//p')
  USERNAME=$(printf 'protocol=https\nhost=github.com\n\n' | git credential-osxkeychain get | sed -n 's/^username=//p')
  [ -n "$USERNAME" ] || die "keychain 里没有用户名"
  # 用凭据调一次 API 确认它真的有效（避免推到最后一步才失败）
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "${USERNAME}:${PW}" https://api.github.com/user)
  [ "$code" = "200" ] || die "keychain 凭据无效（HTTP ${code}），请重新登录或更新凭据"
fi
say "    账号：${USERNAME}"

# ---------------------------------------------------------------------------
say "==> 4/5 确保远程仓库存在"
if [ "$AUTH" = "ssh" ]; then
  git ls-remote "git@${SSH_HOST_ALIAS}:${USERNAME}/${REPO_NAME}.git" >/dev/null 2>&1 \
    && say "    仓库已存在" \
    || say "    仓库不存在或为空——请先在 GitHub 上创建 ${USERNAME}/${REPO_NAME}（本脚本不代建）"
  REMOTE_URL="git@${SSH_HOST_ALIAS}:${USERNAME}/${REPO_NAME}.git"
else
  # HTTPS 分支顺带把仓库建出来，省掉手动步骤。
  PW=$(printf 'protocol=https\nhost=github.com\n\n' | git credential-osxkeychain get | sed -n 's/^password=//p')
  if curl -s -o /dev/null -u "${USERNAME}:${PW}" "https://api.github.com/repos/${USERNAME}/${REPO_NAME}"; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -u "${USERNAME}:${PW}" "https://api.github.com/repos/${USERNAME}/${REPO_NAME}")
  fi
  if [ "${code:-000}" = "200" ]; then
    say "    仓库已存在"
  else
    say "    仓库不存在，正在创建 ${USERNAME}/${REPO_NAME}（public）"
    DESC=$(python3 -c "import json;print(json.load(open('package.json'))['description'])" 2>/dev/null || echo "")
    printf '{"name":"%s","description":%s,"private":false,"auto_init":false}' \
      "$REPO_NAME" "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$DESC")" > /tmp/push-repo.json
    curl -s -X POST -u "${USERNAME}:${PW}" https://api.github.com/user/repos \
      -H 'Accept: application/vnd.github+json' --data-binary @/tmp/push-repo.json >/dev/null
  fi
  REMOTE_URL="https://github.com/${USERNAME}/${REPO_NAME}.git"
fi

# ---------------------------------------------------------------------------
say "==> 5/5 推送 main"
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE_URL"
git -c credential.helper=osxkeychain push -u origin main

say ""
say "完成：https://github.com/${USERNAME}/${REPO_NAME}"
