#!/usr/bin/env node
// manifest/agent-servers.json（数组）→ ~/.agents/servers/<id>.json（每项一个文件）
// 用法: node scripts/split-servers.js <manifest/agent-servers.json> <目标目录>
const fs = require('fs')
const path = require('path')

const [, , src, outDir] = process.argv
if (!src || !outDir) {
  console.error('usage: node split-servers.js <agent-servers.json> <outDir>')
  process.exit(1)
}
const arr = JSON.parse(fs.readFileSync(src, 'utf8'))
fs.mkdirSync(outDir, { recursive: true })
for (const s of arr) {
  if (!s || !s.id) continue
  const f = path.join(outDir, s.id + '.json')
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n')
  console.log('    [ok] server ' + s.id)
}