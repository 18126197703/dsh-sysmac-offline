/**
 * 单元自检：不依赖 DSH 运行时，用一个桩 ctx 验证插件契约与工具行为。
 * 用法：node tools/check.mjs [sample.smc2]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(root, 'lib/index.mjs')).href)

const results = []
const ok = (msg) => results.push(`  PASS  ${msg}`)
const bad = (msg) => {
  results.push(`  FAIL  ${msg}`)
  process.exitCode = 1
}

// ── 1. 导出契约 ────────────────────────────────────────────────
if (typeof mod.apply === 'function') ok('导出 apply(ctx)')
else bad('缺少 apply(ctx)')

if (Array.isArray(mod.inject) && mod.inject.includes('tools')) ok(`inject = ${JSON.stringify(mod.inject)}`)
else bad(`inject 必须包含 'tools'，实际 ${JSON.stringify(mod.inject)}`)

if (typeof mod.name === 'string' && mod.name) ok(`插件名 = ${mod.name}`)
else bad('缺少 name')

// ── 2. 工具注册 ────────────────────────────────────────────────
const registered = []
const ctx = {
  tools: { register: (spec) => registered.push(spec) },
  logger: { info: () => {} },
}

try {
  mod.apply(ctx)
  ok('apply() 执行无异常')
} catch (error) {
  bad(`apply() 抛错：${error?.message ?? error}`)
}

const expected = [
  'sysmac_list_slwd_entries',
  'sysmac_read_slwd_raw',
  'sysmac_read_oem_manifest',
  'sysmac_read_pou_body',
]
const names = registered.map((t) => t.name)
for (const name of expected) {
  if (names.includes(name)) ok(`注册 ${name}`)
  else bad(`未注册 ${name}`)
}
if (new Set(names).size === names.length) ok('工具名无重复')
else bad('工具名有重复')

for (const spec of registered) {
  const problems = []
  if (!spec.description) problems.push('缺 description')
  if (!spec.parameters || spec.parameters.type !== 'object') problems.push('parameters 不是 object schema')
  if (spec.parameters && !spec.parameters.additionalProperties === false) problems.push('parameters 未关闭 additionalProperties')
  if (!spec.output?.schema) problems.push('缺 output.schema')
  if (typeof spec.output?.render !== 'function') problems.push('缺 output.render')
  if (typeof spec.execute !== 'function') problems.push('缺 execute')
  if (problems.length) bad(`${spec.name}: ${problems.join(' / ')}`)
}
if (!process.exitCode) ok('4 个工具的 schema 结构完整')

// ── 3. 真实文件执行 ────────────────────────────────────────────
const sample = process.argv[2]
if (sample) {
  if (!fs.existsSync(sample)) {
    bad(`样例文件不存在：${sample}`)
  } else {
    const call = async (name, args) => {
      const spec = registered.find((t) => t.name === name)
      const value = await spec.execute(args)
      // 1) 结果必须是 lossless JSON
      const round = JSON.parse(JSON.stringify(value))
      // 2) render 必须产出文本块
      const blocks = spec.output.render(args, value)
      if (!Array.isArray(blocks) || !blocks.length || blocks[0].type !== 'text') {
        throw new Error(`${name}: render 未返回文本块`)
      }
      return { value, round, text: blocks[0].text }
    }

    const path = sample
    const list = await call('sysmac_list_slwd_entries', { smc2_path: path })
    const count = (list.text.match(/^  - /gm) ?? []).length
    ok(`list_slwd_entries: ${count} 条（${list.text.length} 字符）`)

    const oem = await call('sysmac_read_oem_manifest', { smc2_path: path })
    ok(`read_oem_manifest: ${oem.text.length} 字符，开头 ${JSON.stringify(oem.text.slice(0, 24))}`)

    const body = await call('sysmac_read_pou_body', { smc2_path: path })
    const head = body.text.split('\n')[0]
    ok(`read_pou_body: ${body.text.length} 字符，首行 ${JSON.stringify(head.slice(0, 60))}`)

    if (count > 0) {
      const firstEntry = list.text.match(/^  - (.+?)  \(/m)?.[1]
      const raw = await call('sysmac_read_slwd_raw', { smc2_path: path, entry_name: firstEntry })
      const matchesHeader = raw.text.startsWith('[SLWD')
      if (matchesHeader) ok(`read_slwd_raw: ${raw.text.length} 字符，以 [SLWD 开头`)
      else bad(`read_slwd_raw 内容异常：${JSON.stringify(raw.text.slice(0, 40))}`)
    }

    // 错误路径
    const missing = await call('sysmac_read_oem_manifest', { smc2_path: path + '.nope' })
    if (missing.text.startsWith('Error:')) ok('不存在的路径返回 Error 文本')
    else bad('不存在的路径未返回 Error')

    const wrongEntry = await call('sysmac_read_slwd_raw', { smc2_path: path, entry_name: 'no-such-entry' })
    if (wrongEntry.text.startsWith('Error:')) ok('错误条目名返回 Error 文本')
    else bad('错误条目名未返回 Error')
  }
}

// ── 4. 打包清单 ────────────────────────────────────────────────
for (const file of ['package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'docs/DETAIL.md', 'locale/zh.json', 'locale/en.json']) {
  if (fs.existsSync(path.join(root, file))) ok(`存在 ${file}`)
  else bad(`缺少 ${file}`)
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
if (pkg.dsh?.bundle?.patch === './cordis.patch.yml') ok('dsh.bundle.patch 正确')
else bad('dsh.bundle.patch 配置错误')
if (!pkg.private) ok('package.json 未标记 private（可发布）')
else bad('package.json 仍是 private，无法发布')

const iconBytes = fs.statSync(path.join(root, 'icon.svg')).size
if (iconBytes > 0 && iconBytes <= 256 * 1024) ok(`icon.svg ${iconBytes} 字节（上限 256 KiB）`)
else bad(`icon.svg 大小异常：${iconBytes}`)

for (const locale of ['zh.json', 'en.json']) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'locale', locale), 'utf8'))
    if (data.meta?.title && data.meta?.description && data.meta?.detail) ok(`locale/${locale} meta 完整`)
    else bad(`locale/${locale} 缺 meta 字段`)
    if (data.meta?.detail && !fs.existsSync(path.join(root, data.meta.detail))) {
      bad(`locale/${locale} 的 meta.detail 指向不存在的文件`)
    }
  } catch (error) {
    bad(`locale/${locale} 解析失败：${error?.message ?? error}`)
  }
}

console.log(results.join('\n'))
console.log(`\n${process.exitCode ? '有 FAIL' : '全部通过'}（${results.length} 项检查）`)
