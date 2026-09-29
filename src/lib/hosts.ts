// 主机地址分配：在已成功分配的固定 / 自动网段内登记设备名 -> 单个 IPv4 主机地址。
// 本模块只读取规划结果、校验既有登记，绝不修改规划（plan）、基线、路由汇总与导出数据。
//
// 关键不变量：
//   1. 只能分配网段「可用主机范围」内的地址：网络地址与广播地址一律跳过 / 拒绝；
//   2. 手动地址必须属于登记所属网段，且不得与同网段其他有效登记重复；
//   3. 规划重新计算后，仍合法的登记按稳定 ID 原样保留（地址绝不被静默改写）；
//      不再合法的登记保留在列表中并显式标记失效原因，由用户自行改址或删除。

import { intToIp, ipToInt } from './ip'
import type { HostAssignment, PlanResult, Segment } from './types'

/** 成功分配、带稳定 ownerId 的固定 / 自动网段（主机登记的唯一宿主） */
export type AllocSegment = Segment & { ownerId: string; kind: 'fixed' | 'auto' }

/** 重新计算后登记失效的原因 */
export type HostInvalidReason =
  | 'owner-gone' // 所属需求已删除
  | 'owner-unallocated' // 所属需求当前分配失败（无网段）
  | 'out-of-subnet' // 地址不在所属网段的可用范围内（网段迁移/改掩码等）
  | 'network-address' // 地址是（新）网络地址
  | 'broadcast-address' // 地址是（新）广播地址
  | 'duplicate' // 与同网段另一条有效登记重复

/** 登记经当前规划重新校验后的视图 */
export interface HostRow {
  assignment: HostAssignment
  /** 登记所属网段；失效（需求删除/分配失败）时为 null */
  segment: AllocSegment | null
  valid: boolean
  reason?: HostInvalidReason
  /** 失效原因的中文说明（有效时为 undefined） */
  reasonText?: string
}

/** 每个网段的主机占用统计（失效登记不占用地址） */
export interface SegmentHostStats {
  segment: AllocSegment
  rows: HostRow[]
  /** 有效登记数 */
  used: number
  /** 剩余可用地址数 = 可用主机数 - 有效登记数 */
  remaining: number
}

export function isAllocSegment(s: Segment): s is AllocSegment {
  return (s.kind === 'fixed' || s.kind === 'auto') && !!s.ownerId
}

/** 当前规划中可登记主机地址的网段（按地址升序，与规划结果顺序一致） */
export function allocatableSegments(result: PlanResult): AllocSegment[] {
  return result.segments.filter(isAllocSegment)
}

function reasonToText(reason: HostInvalidReason, ctx: { assignment: HostAssignment; segment: AllocSegment | null }): string {
  const ip = intToIp(ctx.assignment.address)
  switch (reason) {
    case 'owner-gone':
      return `所属需求已删除，地址 ${ip} 不再属于任何网段`
    case 'owner-unallocated':
      return `所属需求“${ctx.assignment.name || '未命名'}”当前分配失败，登记地址 ${ip} 已失效`
    case 'out-of-subnet':
      return `地址 ${ip} 不在当前网段 ${ctx.segment?.cidr ?? ''} 的可用范围 ${
        ctx.segment ? `${ctx.segment.firstUsable} ~ ${ctx.segment.lastUsable}` : '—'
      } 内`
    case 'network-address':
      return `地址 ${ip} 是当前网段的网络地址，不能分配给主机`
    case 'broadcast-address':
      return `地址 ${ip} 是当前网段的广播地址，不能分配给主机`
    case 'duplicate':
      return `地址 ${ip} 与本网段另一条登记重复`
  }
}

/**
 * 用当前规划重新校验全部登记（按稳定 ownerId 匹配网段）。
 * 同网段重复时，保留录入顺序最早的一条为有效，其余标记为重复；
 * 失效登记保留原地址与原方式，不做任何静默修正。
 */
export function reconcileHosts(
  assignments: HostAssignment[],
  result: PlanResult,
): { rows: HostRow[]; statsByOwner: Map<string, SegmentHostStats> } {
  const segByOwner = new Map<string, AllocSegment>()
  for (const seg of allocatableSegments(result)) segByOwner.set(seg.ownerId, seg)

  // 每个网段内最早占用某地址的登记索引（只有地址仍在可用范围内才占用）
  const firstOwnerOfAddr = new Map<string, number>()

  const rows: HostRow[] = assignments.map((assignment, index) => {
    const segment = segByOwner.get(assignment.ownerId) ?? null
    let reason: HostInvalidReason | undefined

    if (!segment) {
      // 需求可能已被删除，或当前分配失败：两种情况都无法再对应到网段
      reason = result.failures.some((f) => f.id === assignment.ownerId)
        ? 'owner-unallocated'
        : 'owner-gone'
    } else if (assignment.address === segment.start) {
      reason = 'network-address'
    } else if (assignment.address === segment.end) {
      reason = 'broadcast-address'
    } else if (assignment.address < segment.start || assignment.address > segment.end) {
      reason = 'out-of-subnet'
    } else {
      const key = `${segment.ownerId}#${assignment.address}`
      const first = firstOwnerOfAddr.get(key)
      if (first === undefined) {
        firstOwnerOfAddr.set(key, index)
      } else {
        reason = 'duplicate'
      }
    }

    const row: HostRow = { assignment, segment, valid: reason === undefined, reason }
    if (reason) row.reasonText = reasonToText(reason, { assignment, segment })
    return row
  })

  const statsByOwner = new Map<string, SegmentHostStats>()
  for (const seg of segByOwner.values()) {
    const segRows = rows.filter((r) => r.assignment.ownerId === seg.ownerId)
    const used = segRows.filter((r) => r.valid).length
    statsByOwner.set(seg.ownerId, {
      segment: seg,
      rows: segRows,
      used,
      remaining: Math.max(0, seg.usable - used),
    })
  }

  return { rows, statsByOwner }
}

/**
 * 校验一次手动输入。返回 null 表示可接受；否则返回面向用户的拒绝原因。
 * 注意：网络地址 / 广播地址即使数值落在网段区间内也必须拒绝。
 */
export function validateManualAddress(
  raw: string,
  segment: AllocSegment,
  assignments: HostAssignment[],
  selfId?: string,
): string | null {
  const value = raw.trim()
  if (!value) return '请输入 IPv4 地址'
  const addr = ipToInt(value)
  if (Number.isNaN(addr)) return `“${value}”不是合法的 IPv4 地址`
  if (addr === segment.start) return `${value} 是网络地址，不能分配给主机`
  if (addr === segment.end) return `${value} 是广播地址，不能分配给主机`
  if (addr < segment.start || addr > segment.end) {
    return `${value} 不在网段 ${segment.cidr} 的可用范围 ${segment.firstUsable} ~ ${segment.lastUsable} 内`
  }
  const clash = assignments.find(
    (a) => a.id !== selfId && a.ownerId === segment.ownerId && a.address === addr,
  )
  if (clash) {
    return `${value} 已被设备“${clash.name || '未命名'}”占用`
  }
  return null
}

/**
 * 自动选取网段内第一个未占用的可用主机地址（跳过网络地址与广播地址）。
 * occupied 为该网段全部既有登记地址（含失效登记也避让，避免改址后立刻撞地址）。
 * 无可用地址时返回 null。
 */
export function firstFreeAddress(
  segment: AllocSegment,
  assignments: HostAssignment[],
): number | null {
  const occupied = new Set(
    assignments.filter((a) => a.ownerId === segment.ownerId).map((a) => a.address),
  )
  // /30 及以上网段：可用范围恒为 network+1 .. broadcast-1
  for (let addr = segment.start + 1; addr <= segment.end - 1; addr++) {
    if (!occupied.has(addr)) return addr >>> 0
  }
  return null
}
