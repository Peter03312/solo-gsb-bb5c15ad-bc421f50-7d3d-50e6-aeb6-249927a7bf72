// DHCP 动态地址池生成（dnsmasq dhcp-range）。
// 本模块只读取当前规划结果、主机登记与面板录入，绝不修改规划、基线、路由汇总、主机登记与导出。
//
// 生成规则：
//   - 选择一个当前「成功分配」的固定 / 自动网段作为宿主网段；
//   - 候选地址空间为网段可用主机范围（网络地址与广播地址由模块自动排除，
//     即使手工排除区间覆盖它们也不会额外占用可分配数量）；
//   - 自动排除该网段内当前「有效」的主机登记地址（失效登记不参与、不阻断）；
//   - 用户可录入多段手工排除区间：两端必须是合法 IPv4、完全位于所选网段内、
//     起止有序（结束留空表示仅排除起始单地址）；
//   - 手工区间重叠或首尾相邻时先合并去重；
//   - 剩余地址按连续区间生成 dnsmasq 配置：
//       dhcp-range=<起始>,<结束>,<点分掩码>
//   - 任一录入条目无效都停止整体生成（不输出任何配置行），并按录入序号逐条给出错误定位。
//
// 规划、登记或排除项变化后由 React 记忆化实时重算；宿主网段失效时调用方暂停输出，
// 选择与全部录入均保留。

import { intToIp, ipToInt, prefixMask } from './ip'
import { mergeRanges } from './baseline'
import { allocatableSegments, reconcileHosts, type AllocSegment } from './hosts'
import type { AddrRange, DhcpExclusionInput, HostAssignment, PlanResult } from './types'

export interface DhcpPoolError {
  /** 录入序号（在全部行中的位置，从 1 开始），用于明确定位 */
  index: number
  message: string
}

/** 合并后的手工排除区间（重叠/相邻已合并），用于预览 */
export interface DhcpMergedExclusion {
  start: number
  end: number
  startIp: string
  endIp: string
  /** 区间地址总数（含首尾） */
  count: number
}

/** 一行录入的实时校验视图（编辑器逐行展示错误） */
export interface DhcpExclusionRowView {
  id: string
  index: number
  /** 起始与结束均为空白的行：占位行，不参与校验也不计数 */
  empty: boolean
  start: number | null
  startIp: string | null
  end: number | null
  endIp: string | null
  /** 本行自身无误时的数值区间（结束留空时为单地址区间）；否则为 null */
  range: AddrRange | null
  errors: string[]
}

/** 一段自动排除的主机登记地址（该网段内当前有效登记） */
export interface DhcpHostExclusion {
  assignment: HostAssignment
  address: number
  ip: string
  name: string
}

/** 一段可分配动态地址池（连续区间） */
export interface DhcpPoolRange {
  start: number
  end: number
  startIp: string
  endIp: string
  /** 本段可分配地址数（含首尾） */
  count: number
  /** dhcp-range=<起始>,<结束>,<掩码> */
  line: string
}

export interface DhcpPoolResult {
  rows: DhcpExclusionRowView[]
  /** 拍平后的全部录入错误（含序号定位） */
  errors: DhcpPoolError[]
  /** 合并后的手工排除区间（仅全部录入有效时有意义） */
  mergedManual: DhcpMergedExclusion[]
  /** 自动排除的主机登记（该网段内当前有效登记，按地址升序） */
  hostExclusions: DhcpHostExclusion[]
  /** 可分配地址池分段（按地址升序）；有错或无候选时为空 */
  pools: DhcpPoolRange[]
  /** 可分配地址总数（各段数量之和） */
  total: number
  /** 点分十进制子网掩码，如 255.255.255.252 */
  netmask: string
  /** 全部 dhcp-range 配置行（换行连接）；不可生成时为空串 */
  configText: string
}

/** 在当前规划中解析宿主网段（必须是成功分配的固定 / 自动网段）；失效返回 null */
export function resolvePoolSegment(result: PlanResult, ownerId: string): AllocSegment | null {
  if (!ownerId) return null
  return allocatableSegments(result).find((s) => s.ownerId === ownerId) ?? null
}

/**
 * 收集宿主网段内当前有效登记地址（供地址池自动排除）。
 * 失效登记（越界 / 网络 / 广播 / 重复 / 孤儿）不参与、不阻断。
 */
export function effectiveHostsOf(
  assignments: HostAssignment[],
  result: PlanResult,
  segment: AllocSegment,
): DhcpHostExclusion[] {
  const { rows } = reconcileHosts(assignments, result)
  return rows
    .filter((r) => r.valid && r.assignment.ownerId === segment.ownerId)
    .map((r) => ({
      assignment: r.assignment,
      address: r.assignment.address,
      ip: intToIp(r.assignment.address),
      name: r.assignment.name.trim() || '未命名设备',
    }))
    .sort((a, b) => a.address - b.address)
}

/**
 * 依据当前宿主网段、主机登记与排除录入生成动态地址池视图。
 * 调用方应在宿主网段失效（resolvePoolSegment 为 null）或输入非法时暂停调用并暂停展示结果。
 */
export function buildDhcpPool(
  entries: DhcpExclusionInput[],
  assignments: HostAssignment[],
  result: PlanResult,
  segment: AllocSegment,
): DhcpPoolResult {
  const netmask = intToIp(prefixMask(segment.prefix))
  // 可用主机范围：网络地址与广播地址自动排除后的候选空间
  const usableStart = segment.start + 1
  const usableEnd = segment.end - 1

  // 该网段内当前有效登记地址（失效登记不参与、不阻断），按地址升序
  const hostExclusions = effectiveHostsOf(assignments, result, segment)

  const rows: DhcpExclusionRowView[] = []
  const errors: DhcpPoolError[] = []
  const segRangeText = `${intToIp(segment.start)} ~ ${intToIp(segment.end)}`

  entries.forEach((entry, i) => {
    const index = i + 1
    const startRaw = entry.start.trim()
    const endRaw = entry.end.trim()
    const rowErrors: string[] = []

    if (!startRaw && !endRaw) {
      rows.push({
        id: entry.id,
        index,
        empty: true,
        start: null,
        startIp: null,
        end: null,
        endIp: null,
        range: null,
        errors: [],
      })
      return
    }

    let start: number | null = null
    let end: number | null = null

    if (!startRaw) {
      rowErrors.push('缺少起始 IPv4')
    } else {
      const s = ipToInt(startRaw)
      if (Number.isNaN(s)) {
        rowErrors.push(`起始地址“${startRaw}”不是合法的 IPv4 地址`)
      } else {
        start = s
      }
    }

    // 结束留空表示仅排除起始单地址
    if (endRaw) {
      const e = ipToInt(endRaw)
      if (Number.isNaN(e)) {
        rowErrors.push(`结束地址“${endRaw}”不是合法的 IPv4 地址`)
      } else {
        end = e
      }
    } else if (start !== null) {
      end = start
    }

    let inSubnet = true
    if (start !== null && end !== null) {
      if (end < start) {
        rowErrors.push(
          `起止顺序颠倒：结束 ${intToIp(end)} 小于起始 ${intToIp(start)}（起止须有序）`,
        )
        inSubnet = false
      } else {
        if (start < segment.start || start > segment.end) {
          rowErrors.push(`起始地址 ${intToIp(start)} 不在网段 ${segment.cidr}（${segRangeText}）内`)
          inSubnet = false
        }
        if (end < segment.start || end > segment.end) {
          rowErrors.push(`结束地址 ${intToIp(end)} 不在网段 ${segment.cidr}（${segRangeText}）内`)
          inSubnet = false
        }
      }
    }

    const range = start !== null && end !== null && inSubnet ? { start, end } : null

    for (const message of rowErrors) errors.push({ index, message })
    rows.push({
      id: entry.id,
      index,
      empty: false,
      start,
      startIp: start !== null ? intToIp(start) : null,
      end,
      endIp: end !== null ? intToIp(end) : null,
      range,
      errors: rowErrors,
    })
  })

  if (errors.length > 0) {
    return {
      rows,
      errors,
      mergedManual: [],
      hostExclusions,
      pools: [],
      total: 0,
      netmask,
      configText: '',
    }
  }

  // 手工排除区间：重叠或相邻先合并（落在网络/广播地址上的部分随后在裁剪候选时自然忽略）
  const mergedManualRanges = mergeRanges(
    rows.filter((r) => !r.empty && r.range).map((r) => r.range as AddrRange),
  )
  const mergedManual: DhcpMergedExclusion[] = mergedManualRanges.map((r) => ({
    start: r.start,
    end: r.end,
    startIp: intToIp(r.start),
    endIp: intToIp(r.end),
    count: r.end - r.start + 1,
  }))

  // 全部排除：手工区间 ∪ 有效主机登记（主机地址恒在可用范围内）
  const excludedRanges = mergeRanges([
    ...mergedManualRanges,
    ...hostExclusions.map((h) => ({ start: h.address, end: h.address })),
  ])

  // 在可用主机范围内扣除排除区间，得到连续可分配区间
  const pools: DhcpPoolRange[] = []
  let cursor = usableStart
  for (const ex of excludedRanges) {
    const cutStart = Math.max(ex.start, usableStart)
    const cutEnd = Math.min(ex.end, usableEnd)
    if (cutEnd < usableStart || cutStart > usableEnd) continue
    if (cursor < cutStart) {
      pools.push(makePool(cursor, cutStart - 1, netmask))
    }
    if (cutEnd + 1 > cursor) cursor = cutEnd + 1
  }
  if (cursor <= usableEnd) pools.push(makePool(cursor, usableEnd, netmask))

  const total = pools.reduce((n, p) => n + p.count, 0)
  const configText = pools.map((p) => p.line).join('\n')

  return {
    rows,
    errors,
    mergedManual,
    hostExclusions,
    pools,
    total,
    netmask,
    configText,
  }
}

function makePool(start: number, end: number, netmask: string): DhcpPoolRange {
  const startIp = intToIp(start)
  const endIp = intToIp(end)
  return {
    start,
    end,
    startIp,
    endIp,
    count: end - start + 1,
    line: `dhcp-range=${startIp},${endIp},${netmask}`,
  }
}

/** 下载为 .conf 文件（Blob 方式，纯前端，不经过任何服务器） */
export function downloadDhcpPoolConf(text: string, segment: AllocSegment) {
  const blob = new Blob([`${text}\n`], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const segTag = segment.cidr.replace(/\//g, '_')
  a.href = url
  a.download = `dnsmasq-dhcp-range-${segTag}-${stamp}.conf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
