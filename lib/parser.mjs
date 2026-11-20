/**
 * Sysmac Studio (.smc2) 离线解析 —— Node.js 零依赖实现。
 *
 * .smc2 本质是一个 ZIP 容器，内部按 "<SolutionId>/<EntityId>.xml" 存放各类实体：
 *   - 变量表      : 以 "[SLWD" 开头的自定义文本格式
 *   - 程序逻辑体  : PouBody，条目名同样是 "<GUID>.xml"，但内容是 JSON（梯形图元素序列）
 *   - 工程实体清单: .oem，XML 格式，记录实体层级、类型与名称
 *
 * 注意：PouBody 的扩展名是 .xml，内容却是 JSON，因此不能按 XML 解析。
 *
 * 本文件不依赖任何第三方包：ZIP 由内置中央目录解析 + node:zlib 解压，
 * .oem 由轻量标签扫描器解析。这样插件在任何装了 DSH 的机器上都能直接跑，
 * 不需要 Python、不需要 uv、不需要联网装依赖。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** GUID：8-4-4-4-12 */
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * 极简 ZIP 读取器：只做"列出条目 + 读取单个条目内容"。
 * 支持 store（0）与 deflate（8），不支持加密与 ZIP64。
 */
export class Smc2Archive {
  constructor(filePath) {
    this.filePath = filePath
    this.buffer = fs.readFileSync(filePath)
    this.entries = new Map()
    this._readCentralDirectory()
  }

  _readCentralDirectory() {
    const buf = this.buffer
    const minPos = Math.max(0, buf.length - 66_000) // EOCD + 最大注释长度
    let eocd = -1
    for (let i = buf.length - 22; i >= minPos; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 容器（找不到 EOCD 记录）：' + this.filePath)

    const total = buf.readUInt16LE(eocd + 10)
    let offset = buf.readUInt32LE(eocd + 16)

    for (let i = 0; i < total; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) break
      const flags = buf.readUInt16LE(offset + 8)
      const method = buf.readUInt16LE(offset + 10)
      const compressedSize = buf.readUInt32LE(offset + 20)
      const uncompressedSize = buf.readUInt32LE(offset + 24)
      const nameLen = buf.readUInt16LE(offset + 28)
      const extraLen = buf.readUInt16LE(offset + 30)
      const commentLen = buf.readUInt16LE(offset + 32)
      const localOffset = buf.readUInt32LE(offset + 42)
      const nameBytes = buf.subarray(offset + 46, offset + 46 + nameLen)
      const name = nameBytes.toString(flags & 0x800 ? 'utf8' : 'latin1')

      this.entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset })
      offset += 46 + nameLen + extraLen + commentLen
    }

    if (!this.entries.size) throw new Error('ZIP 中央目录为空，文件可能已损坏：' + this.filePath)
  }

  /** ZIP 内的条目名列表（保持容器内原始顺序）。 */
  names() {
    return [...this.entries.keys()]
  }

  /** 读取单个条目为 Buffer。 */
  read(name) {
    const entry = this.entries.get(name)
    if (!entry) throw new Error('条目不存在：' + name)

    const buf = this.buffer
    const lh = entry.localOffset
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== LOCAL_SIG) {
      throw new Error('本地文件头无效：' + name)
    }
    const nameLen = buf.readUInt16LE(lh + 26)
    const extraLen = buf.readUInt16LE(lh + 28)
    const start = lh + 30 + nameLen + extraLen
    const data = buf.subarray(start, start + entry.compressedSize)

    if (entry.method === 0) return data
    if (entry.method === 8) {
      try {
        return zlib.inflateRawSync(data)
      } catch (error) {
        throw new Error(`解压失败（${name}）：${error?.message ?? error}`)
      }
    }
    throw new Error(`不支持的压缩方式 ${entry.method}（${name}）`)
  }

  /** 读取条目文本，处理编码问题并去掉 UTF-8 BOM。 */
  readText(name) {
    const data = this.read(name)
    let text = data.toString('utf8')
    // UTF-8 解码出现替换字符 → 说明不是 UTF-8，退化为 latin1
    if (text.includes('\uFFFD')) {
      const fallback = data.toString('latin1')
      if (!fallback.includes('\uFFFD')) text = fallback
    }
    return text.replace(/^\uFEFF/, '')
  }

  /** 按扩展名查找第一个匹配条目（不区分大小写）。 */
  findFirst(suffix) {
    const lower = suffix.toLowerCase()
    for (const name of this.entries.keys()) {
      if (name.toLowerCase().endsWith(lower)) return name
    }
    return null
  }

  close() {
    this.buffer = null
    this.entries.clear()
  }
}

/** 打开 .smc2（调用方负责 close）。 */
export function openArchive(filePath) {
  return new Smc2Archive(filePath)
}

/* ─────────────────────────── 变量表（SLWD） ─────────────────────────── */

/** 扫描 .smc2 中所有包含 [SLWD 标记的 XML 条目。返回 { 条目名: 文本 }。 */
export function findSlwdEntries(archive) {
  const results = {}
  for (const name of archive.names()) {
    if (!name.toLowerCase().endsWith('.xml')) continue
    let content
    try {
      content = archive.readText(name)
    } catch {
      continue
    }
    if (content.slice(0, 50).trim().includes('[SLWD')) results[name] = content
  }
  return results
}

/* ─────────────────────────── 工程实体清单（.oem） ─────────────────────────── */

/** 读取 .smc2 中的 .oem 工程实体清单原文。 */
export function readOemManifest(archive) {
  const name = archive.findFirst('.oem')
  if (!name) return null
  return archive.readText(name)
}

/** 从标签属性串里取出所有 key="value"。 */
function parseAttrs(attrText) {
  const attrs = {}
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g
  let match
  while ((match = re.exec(attrText)) !== null) attrs[match[1]] = match[2]
  return attrs
}

/**
 * 解析 .oem 清单，返回 { 实体ID(小写): {id, type, subtype, name, dn, parent} }。
 * parent 为父实体 ID（小写），用于还原实体层级路径。
 *
 * 说明：.oem 的实体是 <Entity> 嵌套在 <ChildEntities> 里；
 * 这里用标签扫描 + 栈来还原父子关系，避免引入 XML 依赖。
 */
export function loadEntityIndex(archive) {
  const index = {}
  const text = readOemManifest(archive)
  if (!text) return index

  const entityRe = /<\/?Entity\b([^>]*?)(\/?)>|<\/?ChildEntities\b[^>]*>/g
  const stack = []
  let match
  while ((match = entityRe.exec(text)) !== null) {
    const raw = match[0]
    if (/^<\/Entity/.test(raw)) {
      stack.pop()
      continue
    }
    if (/^<ChildEntities/.test(raw) || /^<\/ChildEntities/.test(raw)) continue

    const attrs = parseAttrs(match[1] ?? '')
    const eid = String(attrs.id ?? '').toLowerCase()
    const selfClosing = match[2] === '/'
    if (eid) {
      index[eid] = {
        id: eid,
        type: attrs.type ?? '',
        subtype: attrs.subtype ?? '',
        name: attrs.name ?? '',
        dn: attrs.DN ?? '',
        parent: stack.length ? stack[stack.length - 1] : null,
      }
    }
    if (!selfClosing) {
      if (eid) stack.push(eid)
      else stack.push(null)
    }
  }
  return index
}

/** 把实体 ID 还原成 "程序 → Program0 → Section0" 形式的层级路径。 */
export function entityPath(index, entityId, maxDepth = 16) {
  const labels = []
  let cursor = String(entityId ?? '').toLowerCase()
  for (let i = 0; i < maxDepth; i++) {
    const info = cursor ? index[cursor] : undefined
    if (!info) break
    labels.push(info.dn || info.name || info.id)
    cursor = info.parent
  }
  return labels.reverse().join(' → ')
}

/* ─────────────────────────── 程序逻辑体（PouBody） ─────────────────────────── */

function stemOf(name) {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function isGuidXml(name) {
  if (!name.toLowerCase().endsWith('.xml')) return false
  return GUID_RE.test(stemOf(name))
}

/** 清单缺失时的兜底判断：PouBody 是 JSON，且用 CLs/__type 描述梯形图元素。 */
function looksLikePouBody(text) {
  const head = text.slice(0, 4096)
  if (!head.trimStart().startsWith('{')) return false
  return head.includes('"CLs"') || head.includes('"__type"')
}

/**
 * 扫描 .smc2 中所有 PouBody 条目。
 * 优先依据 .oem 里 type="PouBody" 的实体 ID 定位 "<GUID>.xml"；清单缺失时退化为内容嗅探。
 */
export function findPouBodyEntries(archive, entityIndex) {
  const index = entityIndex ?? loadEntityIndex(archive)
  const bodyIds = new Set()
  for (const [eid, info] of Object.entries(index)) {
    if (info.type === 'PouBody') bodyIds.add(eid)
  }

  const results = {}
  for (const name of archive.names()) {
    if (!isGuidXml(name)) continue
    let content
    try {
      content = archive.readText(name)
    } catch {
      continue
    }
    const stem = stemOf(name).toLowerCase()
    if (bodyIds.has(stem) || looksLikePouBody(content)) results[name] = content
  }
  return results
}

/** 把用户给的条目名解析为实际条目名（完整名 / "<GUID>.xml" / 裸 GUID / 路径尾部）。 */
export function resolvePouBodyEntry(entries, entryName) {
  const target = String(entryName ?? '').trim().replace(/\\/g, '/')
  if (!target) return null
  if (Object.prototype.hasOwnProperty.call(entries, target)) return target

  const low = target.toLowerCase()
  for (const key of Object.keys(entries)) {
    const base = key.split('/').pop() ?? key
    if (
      key.toLowerCase().endsWith(low) ||
      base.toLowerCase() === low ||
      stemOf(base).toLowerCase() === low ||
      base.toLowerCase() === `${low}.xml`
    ) {
      return key
    }
  }
  return null
}

/**
 * 把 PouBody 正文拆成多条 rung。
 * 一个 Section 可以含多条 rung，文件里每行一个 JSON 对象（Sysmac 1.68 的实际存储格式）。
 */
export function parseRungs(content) {
  const rungs = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    try {
      const data = JSON.parse(line)
      if (data && typeof data === 'object' && !Array.isArray(data)) rungs.push(data)
    } catch {
      continue
    }
  }
  return rungs
}

/** 把指令框的 In/Out 引脚列表压成一行。 */
function formatPins(pins, side) {
  if (!Array.isArray(pins)) return ''
  const parts = []
  for (const pin of pins) {
    if (!pin || typeof pin !== 'object') continue
    const kind = pin.__type
    const arg = String(pin.Arg ?? '')
    if (kind === 'PF') {
      if (arg) parts.push(arg)
      continue
    }
    const variable = String(pin.Var ?? '')
    const label = arg || '?'
    parts.push(variable ? `${label} := ${variable}` : label)
  }
  return parts.length ? `${side}: ${parts.join(', ')}` : ''
}

/** 把单个单元格渲染成可读的一行。 */
function formatCell(cell) {
  const etype = String(cell.__type ?? '?')
  const variable = String(cell.Var ?? '').trim()
  const row = cell.Y
  const prefix = row ? `行${row} ` : ''

  if (etype === 'LD') {
    const mark = cell.Not ? '[/]' : '[ ]'
    const edge = cell.Up ? '[↑]' : cell.Dwn ? '[↓]' : ''
    return `${prefix}LD   ${mark}${edge} ${variable}`
  }
  if (etype === 'ST') {
    const mark = cell.S ? '(S)' : cell.RS ? '(R)' : '( )'
    return `${prefix}ST   ${mark} ${variable}`
  }
  if (etype === 'F') {
    const nm = cell.Name || 'F'
    const detail = [formatPins(cell.In, 'In'), formatPins(cell.Out, 'Out')].filter(Boolean).join('  ')
    return `${prefix}F    ${nm.padEnd(6)} ${detail}`.trimEnd()
  }
  if (etype === 'FB') {
    const nm = cell.Name || 'FB'
    const detail = [formatPins(cell.In, 'In'), formatPins(cell.Out, 'Out')].filter(Boolean).join('  ')
    return `${prefix}FB   ${nm} (${variable})  ${detail}`.trimEnd()
  }
  if (etype === 'IST') {
    const text = String(cell.TXT ?? '')
    const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
    return `${prefix}IST  [ST 代码块 ${text.split(/\r?\n/).length} 行] ${first.slice(0, 60)}`
  }
  if (etype === 'HL') return ''
  return `${prefix}${etype} ${variable}`.trim()
}

/** 生成 PouBody 的完整可读报告（实体信息 + 源码原文 + 每条 rung 的解读）。 */
export function formatPouBodyReport(archive, entryName = '') {
  const entries = findPouBodyEntries(archive)
  if (!Object.keys(entries).length) {
    return `Error: 未在 ${archive.filePath} 中找到任何 PouBody 逻辑体条目`
  }

  const index = loadEntityIndex(archive)

  let entry
  if (!String(entryName ?? '').trim()) {
    const keys = Object.keys(entries)
    if (keys.length === 1) {
      entry = keys[0]
    } else {
      const lines = [`发现 ${keys.length} 个 PouBody 条目，请通过 entry_name 指定其一：`]
      for (const key of keys) {
        const p = entityPath(index, stemOf(key))
        lines.push(`  - ${key}` + (p ? `    (${p})` : ''))
      }
      lines.push('')
      lines.push('提示：entry_name 可传完整条目名、"<GUID>.xml" 或裸 GUID。')
      return lines.join('\n')
    }
  } else {
    const resolved = resolvePouBodyEntry(entries, entryName)
    if (resolved === null) {
      const lines = [`Error: 条目不存在或不是 PouBody: ${entryName}`, '可用条目：']
      for (const key of Object.keys(entries)) lines.push(`  - ${key}`)
      return lines.join('\n')
    }
    entry = resolved
  }

  const content = entries[entry]
  const entityId = stemOf(entry)
  const info = index[entityId.toLowerCase()] ?? null
  const rungs = parseRungs(content)

  const lines = [`[PouBody] ${entry}`]
  if (info) {
    let kind = info.type || 'PouBody'
    if (info.subtype) kind += ` / ${info.subtype}`
    lines.push(`实体类型 : ${kind}`)
    lines.push(`实体名称 : ${info.dn || info.name}`)
    lines.push(`实体路径 : ${entityPath(index, entityId)}`)
  } else {
    lines.push('实体类型 : PouBody（未在 .oem 清单中匹配到实体信息）')
  }
  lines.push(`梯级数量 : ${rungs.length} 条 rung`)
  lines.push('')
  lines.push('── 源码原文 ──')
  lines.push(content.trim())

  if (!rungs.length) {
    lines.push('')
    lines.push('提示     : 该逻辑体不是梯形图 JSON，可能为 ST / FBD 等其他语言源码。')
    return lines.join('\n')
  }

  lines.push('')
  lines.push('── 逐条 rung 解读 ──')
  rungs.forEach((rung, rungIndex) => {
    const cells = Array.isArray(rung.CLs) ? rung.CLs.filter((c) => c && typeof c === 'object') : []
    const verticals = Array.isArray(rung.VLs) ? rung.VLs.filter((v) => v && typeof v === 'object') : []
    const comment = String(rung.CMT ?? '').replace(/\r?\n/g, ' ').trim()
    let header = `rung ${rungIndex}: ${cells.length} 个元素`
    if (verticals.length) {
      const cols = [...new Set(verticals.map((v) => v.X).filter((x) => x !== undefined && x !== null))].sort(
        (a, b) => a - b,
      )
      header += `，并联竖线 ${verticals.length} 段（列 ${cols}）`
    }
    lines.push('')
    lines.push(header)
    if (comment) lines.push(`  注释 : ${comment.slice(0, 80)}`)
    for (const cell of cells) {
      const rendered = formatCell(cell)
      if (rendered) lines.push('   ' + rendered)
    }
  })

  return lines.join('\n')
}
