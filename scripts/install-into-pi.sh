#!/usr/bin/env bash
# Put this package on the local Pi agent.
# Pi's launcher is "#!/usr/bin/env node". If node is installed via Homebrew,
# nvm, fnm, or Volta but is not on PATH, that launcher exits with
# "env: node: No such file or directory" before pi install runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node"
  do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    . "$HOME/.nvm/nvm.sh"
    if command -v node >/dev/null 2>&1; then
      command -v node
      return 0
    fi
  fi
  return 1
}

if ! NODE="$(find_node)"; then
  cat <<'EOF' >&2
找不到 node。pi 的启动行是 #!/usr/bin/env node，所以当前这个终端一启动 pi 就会退出。

在这台 Mac 上安装 Node.js 22 或更新版本，然后重新打开终端：

  brew install node

装好后确认：

  node -v
  command -v pi
EOF
  exit 1
fi

export PATH="$(dirname "$NODE"):$PATH"
hash -r

if ! command -v pi >/dev/null 2>&1; then
  cat <<EOF >&2
node 在 $NODE，但 PATH 里没有 pi。
先安装 Pi：https://pi.dev
然后在这个目录运行：

  pi install "$ROOT"
EOF
  exit 1
fi

echo "使用 node: $NODE ($("$NODE" -v))"
echo "安装包: $ROOT"
pi install "$ROOT"
echo "装好了。新开一个 pi 会话，运行 /hermes status。"
