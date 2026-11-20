/**
 * 临时验证脚本：用 Node 解析器跑真实 .smc2，输出与 Python 版可对比的摘要。
 * 用法：node tools/selftest.mjs <file.smc2> [entryName]
 */
import path from 'node:path'
import {
  openArchive,
  findSlwdEntries,
  readOemManifest,
  loadEntityIndex,
  findPouBodyEntries,
  formatPouBodyReport,
} from '../lib/parser.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node tools/selftest.mjs <file.smc2> [entryName]')
  process.exit(2)
}

const started = Date.now()
const archive = openArchive(file)
const out = []
out.push(`file      : ${path.basename(file)}`)
out.push(`zip entries: ${archive.names().length}`)

const slwd = findSlwdEntries(archive)
out.push(`SLWD entries: ${Object.keys(slwd).length}`)
for (const [name, body] of Object.entries(slwd)) {
  out.push(`  - ${name}  (${body.length} chars)`)
  out.push(`    head: ${JSON.stringify(body.slice(0, 80))}`)
}

const oem = readOemManifest(archive)
out.push(`oem manifest: ${oem === null ? 'NOT FOUND' : `${oem.length} chars`}`)

const index = loadEntityIndex(archive)
out.push(`entity index: ${Object.keys(index).length} entities`)
const types = {}
for (const e of Object.values(index)) types[e.type || '(none)'] = (types[e.type || '(none)'] ?? 0) + 1
out.push(`  types: ${JSON.stringify(types)}`)

const bodies = findPouBodyEntries(archive)
out.push(`PouBody entries: ${Object.keys(bodies).length}`)
for (const name of Object.keys(bodies)) out.push(`  - ${name}`)

const which = process.argv[3] ?? ''
if (Object.keys(bodies).length) {
  out.push('')
  out.push('=== report ===')
  out.push(formatPouBodyReport(archive, which))
}

out.push('')
out.push(`elapsed: ${Date.now() - started} ms`)
archive.close()
console.log(out.join('\n'))
