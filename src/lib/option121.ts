// DHCP Option 121（RFC 3442 无分类静态路由）生成。
// 本模块只读取当前规划结果与面板录入，绝不修改规划、基线、路由汇总、主机登记与导出。
//
// RFC 3442 编码（每条路由）：
//   1 字节：目的前缀长度（0-32）
//   ceil(前缀/8) 字节：目的网络地址的最高若干字节（主机位不写出，故 0.0.0.0/0 此处为 0 字节）
//   4 字节：下一跳（网关）IPv4
// 多条路由按「目的前缀从长到短、网络地址升序」排列后依次拼接；
// dnsmasq 配置行形如：dhcp-option=121,8,10,192,168,1,1,...
//
// 任一录入条目无效（目的非规范网络地址、下一跳不在客户端网段可用主机范围、目的重复等）
// 都使整体停止生成（不输出合并字节与配置行），并按录入序号逐条给出错误定位。

import { intToIp, ipToInt, parseCidr } from './ip'
import { allocatableSegments } from './hosts'
import type { Option121RouteInput, PlanResult } from './types'

export interface Option121Error {
  /** 录入序号（在全部行中的位置，从 1 开始），用于明确定位 */
  index: number
  message: string
}

/** 校验通过并已编码的单条路由（顺序为最终下发顺序） */
export interface Option121Route {
  index: number
  /** 规范目的 CIDR */
  destination: string
  network: number
  prefix: number
  gateway: number
  gatewayIp: string
  /** 本条目的 RFC 3442 字节（十进制 0-255） */
  bytes: number[]
}

/** 每行录入的实时校验视图（编辑器逐行展示字节与错误） */
export interface Option121RowView {
  id: string
  index: number
  /** 目的与下一跳均为空白的行：占位行，不参与校验也不计数 */
  empty: boolean
  destination: string | null
  network: number | null
  prefix: number | null
  gatewayIp: string | null
  gateway: number | null
  /** 本行自身无误时的 RFC 3442 字节（即使其他行报错也可逐行预览）；否则为 null */
  bytes: number[] | null
  errors: string[]
}

export interface Option121Result {
  rows: Option121RowView[]
  /** 拍平后的全部错误（含序号前缀） */
  errors: Option121Error[]
  /** 全部条目有效时按 RFC 3442 顺序排列的路由；有错时为空 */
  routes: Option121Route[]
  /** 合并后的全部字节；有错或无条目时为空数组 */
  bytes: number[]
  /** dhcp-option=121,... 配置行；不可生成时为空串 */
  optionLine: string
}

/** 在当前规划中解析客户端网段（必须是成功分配的固定 / 自动网段）；失效返回 null */
export function resolveClientSegment(result: PlanResult, clientId: string) {
  if (!clientId) return null
  return allocatableSegments(result).find((s) => s.ownerId === clientId) ?? null
}

/** 单条路由的 RFC 3442 字节：前缀 + 目的网络高 ceil(prefix/8) 字节 + 4 字节下一跳 */
export function encodeRoute(network: number, prefix: number, gateway: number): number[] {
  const octets = [
    (network >>> 24) & 255,
    (network >>> 16) & 255,
    (network >>> 8) & 255,
    network & 255,
  ]
  const keep = Math.ceil(prefix / 8)
  return [prefix, ...octets.slice(0, keep), (gateway >>> 24) & 255, (gateway >>> 16) & 255, (gateway >>> 8) & 255, gateway & 255]
}

/**
 * 依据当前客户端网段校验并生成 Option 121 视图。
 * 调用方应在客户端网段失效（resolveClientSegment 为 null）或输入非法时暂停调用并暂停展示结果。
 */
export function buildOption121(entries: Option121RouteInput[], client: NonNullable<ReturnType<typeof resolveClientSegment>>): Option121Result {
  const rows: Option121RowView[] = []
  const errors: Option121Error[] = []
  // 规范目的 CIDR -> 首次出现的行序号（重复目的只放过第一条，其余报错）
  const firstDestIndex = new Map<string, number>()

  entries.forEach((entry, i) => {
    const index = i + 1
    const destRaw = entry.destination.trim()
    const gwRaw = entry.gateway.trim()
    const rowErrors: string[] = []

    if (!destRaw && !gwRaw) {
      rows.push({
        id: entry.id,
        index,
        empty: true,
        destination: null,
        network: null,
        prefix: null,
        gatewayIp: null,
        gateway: null,
        bytes: null,
        errors: [],
      })
      return
    }

    let network: number | null = null
    let prefix: number | null = null
    let canonical: string | null = null
    let isDuplicate = false

    if (!destRaw) {
      rowErrors.push('缺少目的 CIDR')
    } else {
      const parsed = parseCidr(destRaw, true)
      if ('error' in parsed) {
        rowErrors.push(`目的网络无效：${parsed.error}`)
      } else {
        network = parsed.network
        prefix = parsed.prefix
        canonical = `${intToIp(network)}/${prefix}`
        const first = firstDestIndex.get(canonical)
        if (first !== undefined) {
          isDuplicate = true
          rowErrors.push(`目的网络 ${canonical} 与第 ${first} 条重复（目的必须唯一）`)
        } else {
          firstDestIndex.set(canonical, index)
        }
      }
    }

    let gateway: number | null = null
    if (!gwRaw) {
      rowErrors.push('缺少下一跳 IPv4')
    } else {
      const gw = ipToInt(gwRaw)
      if (Number.isNaN(gw)) {
        rowErrors.push(`下一跳“${gwRaw}”不是合法的 IPv4 地址`)
      } else {
        gateway = gw
        if (gw === client.start) {
          rowErrors.push(`下一跳 ${gwRaw} 是客户端网段 ${client.cidr} 的网络地址，必须是可用主机地址`)
        } else if (gw === client.end) {
          rowErrors.push(`下一跳 ${gwRaw} 是客户端网段 ${client.cidr} 的广播地址，必须是可用主机地址`)
        } else if (gw < client.start || gw > client.end) {
          rowErrors.push(
            `下一跳 ${gwRaw} 不在客户端网段 ${client.cidr} 的可用范围 ${client.firstUsable} ~ ${client.lastUsable} 内`,
          )
        }
      }
    }

    // 逐行字节预览只取决于本行是否自身有效（重复目的行不给出字节）
    const bytes =
      network !== null && prefix !== null && gateway !== null && !isDuplicate
        ? encodeRoute(network, prefix, gateway)
        : null

    for (const message of rowErrors) errors.push({ index, message })
    rows.push({
      id: entry.id,
      index,
      empty: false,
      destination: canonical,
      network,
      prefix,
      gatewayIp: gateway !== null ? intToIp(gateway) : null,
      gateway,
      bytes,
      errors: rowErrors,
    })
  })

  if (errors.length > 0) {
    return { rows, errors, routes: [], bytes: [], optionLine: '' }
  }

  // 全部有效：目的前缀从长到短（前缀大者优先），网络地址升序
  const routes: Option121Route[] = rows
    .filter((r) => !r.empty)
    .map((r) => ({
      index: r.index,
      destination: r.destination as string,
      network: r.network as number,
      prefix: r.prefix as number,
      gateway: r.gateway as number,
      gatewayIp: r.gatewayIp as string,
      bytes: r.bytes as number[],
    }))
    .sort((a, b) => b.prefix - a.prefix || a.network - b.network)

  const bytes = routes.flatMap((r) => r.bytes)
  const optionLine = routes.length > 0 ? `dhcp-option=121,${bytes.join(',')}` : ''
  return { rows, errors, routes, bytes, optionLine }
}

/** 下载为 .conf 文件（Blob 方式，纯前端，不经过任何服务器） */
export function downloadOption121Conf(optionLine: string) {
  const blob = new Blob([`${optionLine}\n`], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  a.href = url
  a.download = `dnsmasq-dhcp-option121-${stamp}.conf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
