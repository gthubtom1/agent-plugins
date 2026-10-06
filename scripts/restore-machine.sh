#!/usr/bin/env bash
# 换机恢复本机 Pi Agent 环境（Git Bash / WSL 用法；幂等）。
# 依赖：node >= 22.19、npm、pi（@earendil-works/pi-coding-agent 1.0.0）
# 用法：
#   TOOL_ROOT='D:\HACKER' PY_ROOT='D:\EXE' NEWAPI_KEY='sk-…' X64DBG_TOKEN='…' ./scripts/restore-machine.sh
#   SKIP_INSTALL=1 ./scripts/restore-machine.sh     # 只恢复配置，不装包
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_HOME="${PI_HOME:-$HOME/.pi/agent}"
AGENTS_HOME="${AGENTS_HOME:-$HOME/.agents}"
TOOL_ROOT="${TOOL_ROOT:-D:\HACKER}"
PY_ROOT="${PY_ROOT:-D:\EXE}"
NEWAPI_KEY="${NEWAPI_KEY:-}"
X64DBG_TOKEN="${X64DBG_TOKEN:-}"
STAMP="$(date +%Y%m%d-%H%M%S)"
# 模板里路径分隔符写成 \\（JSON 转义），替换值不能含反斜杠（否则渲染出 "\E" 非法转义），统一转正斜杠
TOOL_ROOT="${TOOL_ROOT//\\//}"
PY_ROOT="${PY_ROOT//\\//}"

say() { printf '==> %s\n' "$1"; }
ok()  { printf '    [ok] %s\n' "$1"; }
warn(){ printf '    [!!] %s\n' "$1"; }

render() { # 模板占位符替换
  sed -e "s|\${TOOL_ROOT}|$TOOL_ROOT|g" \
      -e "s|\${PY_ROOT}|$PY_ROOT|g" \
      -e "s|\${X64DBG_MCP_TOKEN}|$X64DBG_TOKEN|g" \
      -e "s|\${NEWAPI_API_KEY}|$NEWAPI_KEY|g" "$1"
}

backup_if_exists() {
  [ -f "$1" ] && cp -f "$1" "$1.bak-$STAMP" && ok "备份 $(basename "$1") -> $(basename "$1").bak-$STAMP"
  return 0
}

if [ "${SKIP_INSTALL:-0}" != "1" ]; then
  say "安装 pi 本体与插件包"
  if ! command -v pi >/dev/null 2>&1; then
    npm i -g @earendil-works/pi-coding-agent@1.0.0
  else ok "pi 已在 PATH：$(pi --version 2>/dev/null | tail -1)"; fi

  command -v pi >/dev/null 2>&1 || warn "pi 不可用，跳过 pi install"
  for p in \
    'npm:pi-plan-task@5.0.7' \
    'npm:@demigodmode/pi-web-agent@1.14.0' \
    'npm:@aaronkyriesenbach/pi-package-manager@0.5.0' \
    'npm:pi-open-tui@0.3.11' \
    'npm:pi-web-access@0.35.0' \
    'npm:pi-mcp-adapter@5.0.0' \
    'npm:pi-tool-display@0.5.0' \
    'npm:pi-win-notify@1.0.15' \
    'npm:@gotgenes/pi-subagents@22.0.0' \
    'git:github.com/gthubtom1/agent-plugins@main'
  do ok "pi install $p"; command -v pi >/dev/null 2>&1 && pi install "$p" || true; done
fi

say "恢复 pi 配置到 $PI_HOME"
mkdir -p "$PI_HOME"
copy_cfg() { # <模板名> <落盘文件名>
  local src="$REPO_ROOT/manifest/$1" dst="$PI_HOME/$2"
  [ -f "$src" ] || { warn "缺少模板 $1，跳过"; return 0; }
  backup_if_exists "$dst"
  render "$src" > "$dst"
  case "$2" in
    *.json) node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$dst" ;;
  esac
  ok "写入 $2"
}
copy_cfg pi-settings.json settings.json
copy_cfg mcp.json         mcp.json
copy_cfg models.json      models.json
copy_cfg open-tui.json    open-tui.json
copy_cfg web-search.json  web-search.json
copy_cfg keybindings.json keybindings.json
copy_cfg trust.json       trust.json

if [ -n "$NEWAPI_KEY" ]; then
  backup_if_exists "$PI_HOME/auth.json"
  printf '{"newapi":{"type":"api_key","key":"%s"}}\n' "$NEWAPI_KEY" > "$PI_HOME/auth.json"
  ok "写入 auth.json"
else warn "未提供 NEWAPI_KEY：请手工填 models.json 的 providers.newapi.apiKey"; fi
[ -n "$X64DBG_TOKEN" ] || warn "未提供 X64DBG_TOKEN：mcp.json 中 x64dbg / x64dbg32 的 Authorization 仍是占位符"

say "恢复共享技能与 MCP server 定义到 $AGENTS_HOME"
if [ -d "$REPO_ROOT/manifest/skills" ]; then
  for d in "$REPO_ROOT"/manifest/skills/*/; do
    name="$(basename "$d")"
    mkdir -p "$AGENTS_HOME/skills/$name"
    cp -f "$d"* "$AGENTS_HOME/skills/$name/" 2>/dev/null || true
    ok "skill $name"
  done
fi
if [ -f "$REPO_ROOT/manifest/agent-servers.json" ]; then
  mkdir -p "$AGENTS_HOME/servers"
  node "$REPO_ROOT/scripts/split-servers.js" "$REPO_ROOT/manifest/agent-servers.json" "$AGENTS_HOME/servers"
  ok "servers: $(ls "$AGENTS_HOME/servers" | tr '\n' ' ')"
fi

say "对账：扩展哈希"
node -e '
  const fs=require("fs"),path=require("path"),cr=require("crypto");
  const base=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const dir=path.join(process.argv[2],"extensions");
  let bad=0;
  for(const [name,want] of Object.entries(base.files)){
    const f=path.join(dir,name);
    if(!fs.existsSync(f)){console.log("[MISS]",name);bad++;continue;}
    const got=cr.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    if(got===want) console.log("[ OK ]",name,got);
    else {console.log("[DIFF]",name,"\n       本机",got,"\n       基线",want);bad++;}
  }
  console.log(bad? `${bad} 项不一致`:"全部一致。");
  process.exit(bad?2:0);
' "$REPO_ROOT/manifest/extensions.sha256.json" "$PI_HOME" || true

echo
echo "完成。重启 pi 后用 /guard status 与 pi list 验证。"