// 在**源机器**上重新生成 manifest/ 下的脱敏配置模板。
//
// 用法：
//   node scripts/regen-manifest.js
//   TOOL_ROOT='D:\Tools' PY_ROOT='D:\Tools\py' node scripts/regen-manifest.js
//
// 设计要点（改动前请先读完）：
//   1. 路径不写死。家目录从 PI_HOME / AGENTS_HOME 或 os.homedir() 取，工具根从环境变量取。
//      写死 `C:/Users/<某人>` 意味着换个人跑这个脚本必然失败，或者更糟 —— 生成出别人的路径。
//   2. ★ 泄露即报错。模板里的本机路径只有两类是允许的：命中 TOOL_ROOT 或 PY_ROOT 的换成占位符；
//      其它任何绝对路径（尤其 C:\Users\<真名>\...）直接抛错退出，而不是照原样写进仓库。
//      「忘记脱敏」这种事不能靠人记得，要靠脚本不让它发生。
//   3. 密钥一律占位：provider apiKey、Authorization Bearer。

const fs = require('fs')
const os = require('os')
const path = require('path')

const H = process.env.PI_HOME || path.join(os.homedir(), '.pi', 'agent')
const A = process.env.AGENTS_HOME || path.join(os.homedir(), '.agents')
const TOOL_ROOT = process.env.TOOL_ROOT || 'D:\\Tools'
const PY_ROOT = process.env.PY_ROOT || 'D:\\Tools\\py'
// 去掉 UTF-8 BOM 再 parse：Windows 上的编辑器 / PowerShell 5.1 的 Out-File 都会写 BOM，
// 直接 JSON.parse 会报 "Unexpected token" —— 这个坑在 936 代码页的机器上尤其常见。
const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const w = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n')

// 本机绝对路径 → 占位符。未命中任何已知根的原样返回（由 assertRedacted 兜底报错）。
const sub = (s) => {
  let out = String(s)
  // 长根先替，否则 PY_ROOT 是 TOOL_ROOT 子目录时会被截成 ${TOOL_ROOT}\py
  for (const [root, ph] of [[PY_ROOT, '${PY_ROOT}'], [TOOL_ROOT, '${TOOL_ROOT}']]) {
    const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp('^' + esc + '\\\\', 'i'), ph + '\\')
    out = out.replace(new RegExp(esc, 'gi'), ph)
  }
  return out
}

// 模板里允许出现的绝对路径：占位符本身、pi 家目录、agents 家目录。
// 其余一律视为泄露 —— 尤其是 C:\Users\<真名>。
const allowed = [H, A].map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

function assertRedacted(where, value) {
  if (typeof value !== 'string') return
  const v = value.replace(/\//g, '\\')
  if (/\$\{[A-Z_]+\}/.test(v)) return // 已经是占位符
  for (const a of allowed) if (v.toLowerCase().includes(a.toLowerCase())) return
  if (!/^[A-Za-z]:\\/.test(v)) return // 相对路径、URL、WSL 路径：不是盘符绝对路径就放过
  throw new Error(
    `脱敏失败：${where} 里出现了未登记的本机绝对路径 —— ${value}\n` +
      `只允许 \${TOOL_ROOT} / \${PY_ROOT} / PI_HOME / AGENTS_HOME 四类。\n` +
      `如果是新的工具根，设 TOOL_ROOT / PY_ROOT 环境变量后重跑；` +
      `如果是家目录路径，改用 os.homedir() 拼，别写死用户名。`,
  )
}

function walk(where, node) {
  if (typeof node === 'string') assertRedacted(where, node)
  else if (Array.isArray(node)) node.forEach((v, i) => walk(`${where}[${i}]`, v))
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      // apiKey / Authorization 一律占位，不参与路径脱敏
      if (k === 'apiKey' || k === 'Authorization') continue
      walk(`${where}.${k}`, v)
    }
  }
}

// 1) settings.json —— 无密钥，原样保留 packages / retry / 扩展策略
w('manifest/pi-settings.json', rd(path.join(H, 'settings.json')))

// 2) mcp.json —— bearer 令牌与本机盘符占位化
const mcp = rd(path.join(H, 'mcp.json'))
for (const [id, s] of Object.entries(mcp.mcpServers)) {
  if (s.headers && s.headers.Authorization) s.headers.Authorization = '${X64DBG_MCP_TOKEN}'
  if (typeof s.command === 'string') s.command = sub(s.command)
  if (Array.isArray(s.args)) s.args = s.args.map(sub)
  if (s.env) for (const k of Object.keys(s.env)) s.env[k] = sub(s.env[k])
}
walk('mcp.json', mcp)
w('manifest/mcp.json', mcp)

// 3) models.json —— apiKey 占位化
const models = rd(path.join(H, 'models.json'))
for (const p of Object.values(models.providers)) if (p.apiKey) p.apiKey = '${NEWAPI_API_KEY}'
w('manifest/models.json', models)

// 4) 其它小配置
for (const f of ['open-tui.json', 'web-search.json', 'keybindings.json', 'trust.json']) {
  w('manifest/' + f, rd(path.join(H, f)))
}

// 5) .agents/servers —— Orca 侧 MCP server 定义
const serversDir = path.join(A, 'servers')
const servers = fs.readdirSync(serversDir).map((f) => rd(path.join(serversDir, f)))
walk('agent-servers.json', servers)
w('manifest/agent-servers.json', servers)

console.log(`manifest written: ${fs.readdirSync('manifest').join(', ')}`)
console.log(`  家目录 ${H}`)
console.log(`  工具根 ${TOOL_ROOT} -> \${TOOL_ROOT}`)
console.log(`  Py 根 ${PY_ROOT} -> \${PY_ROOT}`)