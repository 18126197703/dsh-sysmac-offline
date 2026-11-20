/**
 * 4 个 agent 工具：直接在宿主进程内解析 .smc2，不起子进程、不需要 Python。
 *
 * 输出统一是 { text } —— 宿主把 render() 的结果渲染成一条文本消息，
 * 与旧版 MCP 工具返回的纯文本保持一致，便于既有提示词无缝迁移。
 */
import fs from 'node:fs'

import {
  openArchive,
  findSlwdEntries,
  readOemManifest,
  formatPouBodyReport,
} from './parser.mjs'

const TEXT = (description) => ({ type: 'string', description })

/** 宿主要求"lossless JSON"：undefined / NaN / 函数都会让整次调用失败。 */
function jsonSafe(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(jsonSafe).filter((item) => item !== undefined)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item)
      if (safe !== undefined) out[key] = safe
    }
    return out
  }
  return undefined
}

const outputSchema = {
  type: 'object',
  properties: { text: TEXT('工具返回的可读文本') },
  required: ['text'],
  additionalProperties: false,
}

function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: outputSchema,
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    execute: async (args) => jsonSafe({ text: await spec.execute(args ?? {}) }),
  }
}

const smc2PathParam = (description) => ({ type: 'string', description })

/** 统一的前置检查 + 生命周期管理。 */
async function withArchive(filePath, fn) {
  const target = String(filePath ?? '').trim()
  if (!target) return 'Error: 请提供 smc2_path'
  if (!fs.existsSync(target)) return `Error: 文件不存在: ${target}`
  const stat = fs.statSync(target)
  if (!stat.isFile()) return `Error: 不是文件: ${target}`

  let archive
  try {
    archive = openArchive(target)
    return fn(archive)
  } catch (error) {
    return `Error: ${error?.message ?? error}`
  } finally {
    try {
      archive?.close()
    } catch {
      // 关闭失败不影响结果
    }
  }
}

export function registerTools(ctx) {
  ctx.tools.register(
    tool({
      name: 'sysmac_list_slwd_entries',
      description:
        '列出 .smc2（Sysmac Studio 工程）中所有包含 SLWD 内容的条目名称，用于快速定位变量表。返回条目名清单与数量；后续可用 sysmac_read_slwd_raw 读取其中一条的原文。完全离线解析，不上传文件。',
      parameters: {
        type: 'object',
        properties: { smc2_path: smc2PathParam('.smc2 工程文件的绝对路径') },
        required: ['smc2_path'],
        additionalProperties: false,
      },
      execute: ({ smc2_path }) =>
        withArchive(smc2_path, (archive) => {
          const entries = findSlwdEntries(archive)
          const names = Object.keys(entries)
          if (!names.length) return '未找到包含 [SLWD 标记的条目（该工程可能没有变量表）。'
          const lines = [`共 ${names.length} 个 SLWD 条目：`]
          for (const name of names) lines.push(`  - ${name}  (${entries[name].length} 字符)`)
          return lines.join('\n')
        }),
    }),
  )

  ctx.tools.register(
    tool({
      name: 'sysmac_read_slwd_raw',
      description:
        '读取 .smc2 中指定 SLWD 条目的原始文本内容（变量表的源文本格式）。调用前先用 sysmac_list_slwd_entries 确认条目名称。',
      parameters: {
        type: 'object',
        properties: {
          smc2_path: smc2PathParam('.smc2 工程文件的绝对路径'),
          entry_name: smc2PathParam('条目名，取自 sysmac_list_slwd_entries 的返回结果'),
        },
        required: ['smc2_path', 'entry_name'],
        additionalProperties: false,
      },
      execute: ({ smc2_path, entry_name }) =>
        withArchive(smc2_path, (archive) => {
          const entries = findSlwdEntries(archive)
          const name = String(entry_name ?? '').trim()
          if (!Object.prototype.hasOwnProperty.call(entries, name)) {
            const lines = [`Error: 条目不存在或不是 SLWD 格式: ${name}`, '可用条目：']
            for (const key of Object.keys(entries)) lines.push(`  - ${key}`)
            return lines.join('\n')
          }
          return entries[name]
        }),
    }),
  )

  ctx.tools.register(
    tool({
      name: 'sysmac_read_oem_manifest',
      description:
        '读取 .smc2 中的 .oem 工程实体清单原文（XML）。清单记录了工程内全部实体的层级、类型与名称，是判断结构（设备 / 程序 / 变量表 / 轴 等）的第一手材料。',
      parameters: {
        type: 'object',
        properties: { smc2_path: smc2PathParam('.smc2 工程文件的绝对路径') },
        required: ['smc2_path'],
        additionalProperties: false,
      },
      execute: ({ smc2_path }) =>
        withArchive(smc2_path, (archive) => {
          const content = readOemManifest(archive)
          if (content === null) return 'Error: 未在 .smc2 中找到 .oem 清单文件'
          return content
        }),
    }),
  )

  ctx.tools.register(
    tool({
      name: 'sysmac_read_pou_body',
      description:
        '读取 .smc2 中 PouBody（程序逻辑体，条目名为 <GUID>.xml）的源码逻辑，返回实体层级路径、逻辑语言、元素数量，以及源码原文和解析后的梯形图元素序列。' +
        'entry_name 留空时：若工程只有一个 PouBody 会自动返回，存在多个则列出全部候选条目便于二次指定；entry_name 可传完整条目名、"<GUID>.xml" 或裸 GUID。' +
        '该条目扩展名是 .xml 但内容是 JSON（{"CLs": [...]}），不是 XML。',
      parameters: {
        type: 'object',
        properties: {
          smc2_path: smc2PathParam('.smc2 工程文件的绝对路径'),
          entry_name: smc2PathParam('可选的条目名；留空则自动选择或列出候选'),
        },
        required: ['smc2_path'],
        additionalProperties: false,
      },
      execute: ({ smc2_path, entry_name }) =>
        withArchive(smc2_path, (archive) => formatPouBodyReport(archive, String(entry_name ?? ''))),
    }),
  )
}
