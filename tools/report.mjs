/**
 * 输出 PouBody 报告，用于与 Python 版做字节级 diff。
 * 用法：node tools/report.mjs <file.smc2> <entryName> <outFile>
 *   entryName 传 - 表示空
 */
import fs from 'node:fs'
import { openArchive, formatPouBodyReport } from '../lib/parser.mjs'

const [file, entry, outFile] = process.argv.slice(2)
if (!file || !outFile) {
  console.error('usage: node tools/report.mjs <file.smc2> <entry|-> <outFile>')
  process.exit(2)
}
const archive = openArchive(file)
const text = formatPouBodyReport(archive, entry === '-' ? '' : entry)
archive.close()
fs.writeFileSync(outFile, text, 'utf8')
