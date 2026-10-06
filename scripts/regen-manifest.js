// 在**源机器**上重新生成 manifest/ 下的脱敏配置模板
// 用法: cd <repo> && node scripts/regen-manifest.js
// 密钥会被占位符替换（apiKey -> ${NEWAPI_API_KEY}，Bearer -> ${X64DBG_MCP_TOKEN}），盘符 -> ${TOOL_ROOT}/${PY_ROOT}
const fs = require('fs')
const path = require('path')
const H = 'C:/Users/Toti/.pi/agent'
const A = 'C:/Users/Toti/.agents'
const rd = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const w = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n')

// 1) settings.json —— 无密钥，原样保留 packages / retry / 扩展策略
w('manifest/pi-settings.json', rd(path.join(H, 'settings.json')))

// 2) mcp.json —— bearer 令牌与本机盘符占位化
const mcp = rd(path.join(H, 'mcp.json'))
const sub = s =>
  String(s).replace(/^D:\\EXE\\/, '${PY_ROOT}\\').replace(/^D:\\HACKER\\/, '${TOOL_ROOT}\\')

for (const [id, s] of Object.entries(mcp.mcpServers)) {
  if (s.headers && s.headers.Authorization) s.headers.Authorization = '${X64DBG_MCP_TOKEN}'
  if (typeof s.command === 'string') s.command = sub(s.command)
  if (Array.isArray(s.args)) s.args = s.args.map(sub)
  if (s.env) {
    for (const k of Object.keys(s.env)) {
      s.env[k] = /^D:\\/.test(s.env[k]) ? sub(s.env[k]) : s.env[k]
    }
  }
}
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
w('manifest/agent-servers.json', fs.readdirSync(A + '/servers').map(f => rd(A + '/servers/' + f)))

console.log('manifest written:', fs.readdirSync('manifest').join(', '))