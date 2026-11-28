#!/usr/bin/env bash
# 以「短名」方式把本仓库的 Pi 插件安装到 agent 目录。
#
# 为什么需要这个脚本：
#   `pi install <path>` 会把来源路径写进 settings.json 的 packages 数组，
#   而 pi-web / `pi list` 直接显示这个字符串。
#     - 用相对路径安装 -> 写入 "plugins/pi/lab"，换目录再装就变成一长串
#     - 用绝对路径安装 -> Pi 规范成「相对 agentDir 的路径」，仍是长串
#     - 在 agentDir 下建同名符号链接，再按名字安装 -> 写入干净的短名
#   本脚本采用第三种方式。插件升级只需在仓库里 git pull，链接不需要重建。
#
# 用法：
#   ./scripts/install-pi-plugins.sh                      # 安装默认插件
#   ./scripts/install-pi-plugins.sh -p pi-lab,pi-remote  # 只装指定插件
#   ./scripts/install-pi-plugins.sh -l                   # 只列出状态
#   PI_CODING_AGENT_DIR=/path ./scripts/install-pi-plugins.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_SOURCE="$REPO_ROOT/plugins/pi"

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
LIST_ONLY=0
PLUGINS=""

# 目录名 -> 安装短名。persona 与 persona-old 都注册 /persona，只能启用其中一个。
ALL_NAMES="pi-cmd-guard pi-retry-level pi-remote pi-lab pi-persona pi-rewind pi-persona-old"
DEFAULT_PLUGINS="pi-cmd-guard pi-retry-level pi-remote pi-lab pi-rewind"

dir_for() {
    case "$1" in
        pi-cmd-guard)   echo cmd-guard ;;
        pi-retry-level) echo retry-level ;;
        pi-remote)      echo remote ;;
        pi-lab)         echo lab ;;
        pi-persona)     echo persona ;;
        pi-rewind)      echo rewind ;;
        pi-persona-old) echo persona-old ;;
        *) return 1 ;;
    esac
}

while [ $# -gt 0 ]; do
    case "$1" in
        -l|--list)    LIST_ONLY=1; shift ;;
        -p|--plugins) PLUGINS="${2//,/ }"; shift 2 ;;
        -h|--help)    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

[ -d "$PI_SOURCE" ] || { echo "Pi plugin directory not found: $PI_SOURCE" >&2; exit 1; }

installed_sources() {
    local f="$AGENT_DIR/settings.json"
    [ -f "$f" ] || return 0
    node -e '
        const fs=require("fs");
        try{
            const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
            for(const p of d.packages||[]){
                const s=typeof p==="string"?p:p.source;
                if(s) console.log(s);
            }
        }catch(e){ console.error("Cannot parse settings.json: "+e.message); }
    ' "$f"
}

if [ "$LIST_ONLY" = "1" ]; then
    echo "agentDir: $AGENT_DIR"
    echo
    printf '%-18s %-14s %s\n' NAME SOURCE STATE
    printf '%-18s %-14s %s\n' ---- ------ -----
    INSTALLED="$(installed_sources || true)"
    for name in $ALL_NAMES; do
        dir="$(dir_for "$name")"
        linked=0; [ -e "$AGENT_DIR/$name" ] && linked=1
        in_set=0
        if printf '%s\n' "$INSTALLED" | grep -qx "$name"; then in_set=1; fi
        if [ $in_set = 1 ] && [ $linked = 1 ]; then state=installed
        elif [ $in_set = 1 ]; then state='registered, link missing'
        elif [ $linked = 1 ]; then state='link only, not registered'
        else state='not installed'; fi
        printf '%-18s %-14s %s\n' "$name" "$dir" "$state"
    done
    echo
    LEGACY="$(printf '%s\n' "$INSTALLED" | grep -E '/|\\' | grep -vE '^(npm|git|github|https?|ssh|builtin):' || true)"
    if [ -n "$LEGACY" ]; then
        echo "Long-path entries found (should be short names):"
        printf '%s\n' "$LEGACY" | sed 's/^/  /'
    fi
    exit 0
fi

[ -n "$PLUGINS" ] || PLUGINS="$DEFAULT_PLUGINS"

for name in $PLUGINS; do
    dir_for "$name" >/dev/null || { echo "Unknown plugin name: $name. Available: $ALL_NAMES" >&2; exit 1; }
done
case " $PLUGINS " in
    *" pi-persona "*" pi-persona-old "*) echo "pi-persona and pi-persona-old both register /persona. Pick only one." >&2; exit 1 ;;
esac

command -v pi >/dev/null 2>&1 || { echo 'pi command not found. Install Pi Coding Agent and make sure it is on PATH.' >&2; exit 1; }

mkdir -p "$AGENT_DIR"

# 清掉指向同一插件目录的长路径旧条目，避免同一插件被加载两次。
for entry in $(installed_sources || true); do
    case "$entry" in
        npm:*|git:*|github:*|https:*|http:*|ssh:*|builtin:*) ;;
        */*|*\\*)
            resolved="$entry"
            case "$entry" in /*) ;; *) resolved="$AGENT_DIR/$entry" ;; esac
            for name in $PLUGINS; do
                target="$PI_SOURCE/$(dir_for "$name")"
                if [ "$(cd "$(dirname "$resolved")" 2>/dev/null && pwd -P)/$(basename "$resolved")" = "$target" ]; then
                    pi remove "$entry" >/dev/null 2>&1 || true
                    echo "Remove long-path entry: $entry"
                fi
            done
            ;;
    esac
done

for name in $PLUGINS; do
    target="$PI_SOURCE/$(dir_for "$name")"
    link="$AGENT_DIR/$name"
    if [ ! -d "$target" ]; then
        echo "Skip $name: source not found at $target" >&2
        continue
    fi
    if [ -L "$link" ]; then
        current="$(cd "$(dirname "$link")" && pwd -P)/$(basename "$(readlink "$link")")"
        if [ "$current" != "$target" ]; then
            rm -f "$link"
            ln -s "$target" "$link"
            echo "Rebuild link: $name -> $target"
        else
            echo "Link ready: $name"
        fi
    elif [ -e "$link" ]; then
        echo "Skip $name: $link exists and is not a symlink." >&2
        continue
    else
        ln -s "$target" "$link"
        echo "Create link: $name -> $target"
    fi
done

# Bash 交互与登录 shell 都需设置；登录配置遵循 Bash 的实际读取优先级。
configure_remote_hostname() {
    local profile="$HOME/.profile"
    local startup_file
    local setting='export PI_WEB_HOSTNAME=0.0.0.0'
    if [ -f "$HOME/.bash_profile" ]; then
        profile="$HOME/.bash_profile"
    elif [ -f "$HOME/.bash_login" ]; then
        profile="$HOME/.bash_login"
    fi

    for startup_file in "$HOME/.bashrc" "$profile" "${ZDOTDIR:-$HOME}/.zshrc"; do
        if ! grep -qxF "$setting" "$startup_file" 2>/dev/null; then
            if ! printf '\n%s\n' "$setting" >> "$startup_file"; then
                echo "Failed to persist PI_WEB_HOSTNAME in $startup_file" >&2
                return 1
            fi
        fi
    done
    echo "Configured PI_WEB_HOSTNAME=0.0.0.0 for future Bash and Zsh sessions."
}

for name in $PLUGINS; do
    [ -e "$AGENT_DIR/$name" ] || continue
    # 传绝对路径，让 Pi 规范成相对 agentDir 的短名后写入 settings.json
    if ! pi install "$AGENT_DIR/$name"; then
        echo "Failed to install: $name" >&2
        exit 1
    fi
    if [ "$name" = "pi-remote" ]; then
        configure_remote_hostname || exit 1
    fi
    echo "Installed: $name"
done

echo
echo "Done. Reopen the Pi session, or run /reload in an existing one."
echo "Configured packages:"
installed_sources | sed 's/^/  /'
