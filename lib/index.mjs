/**
 * dsh-sysmac-offline —— DSH 宿主插件入口。
 *
 * 挂载方式（profile 的 cordis.patch.yml，由包内 bundle 自动插入）：
 *   - insert:
 *       - id: sysmac-offline
 *         name: dsh-sysmac-offline
 *
 * 设计要点：解析全部在本进程内完成（node:zlib 解 ZIP + 轻量 .oem 扫描），
 * 不 spawn 子进程、不需要 Python、不需要绝对路径，因此在任何装了 DSH 的机器上
 * 装完即可用。
 */
import { registerTools } from './tools.mjs'

export const name = 'sysmac-offline'
export const inject = ['tools']

export function apply(ctx) {
  registerTools(ctx)
  ctx.logger?.info?.('[sysmac-offline] 4 个 .smc2 解析工具已注册')
}
