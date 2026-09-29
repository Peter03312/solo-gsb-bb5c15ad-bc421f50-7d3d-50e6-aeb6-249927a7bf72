// 路由汇总：把勾选的已成功分配网段（固定/自动）的地址并集，转换为数量最少且覆盖精确的
// CIDR 列表。做法：先合并相邻区间，再按地址对齐边界贪心拆分。由于仅在相邻时合并、
// 且拆分严格对齐 CIDR 边界，只有「同前缀、连续、同属一个上级网段」的两个块才可能被聚合；
// 任何汇总块都不会包含未选需求、保留区或空闲地址。

import { intToIp } from './ip'
import type { Segment } from './types'

export type AllocKind = 'fixed' | 'auto'

export interface SummarySource {
  id: string
  name: string
  /** 原网段 CIDR */
  cidr: string
  kind: AllocKind
  start: number
  end: number
  capacity: number
}

export interface SummaryBlock {
  cidr: string
  network: number
  prefix: number
  /** 块内地址总数 2^(32-prefix) */
  capacity: number
  /** 是否由多个原网段聚合而成 */
  aggregated: boolean
  /** 该汇总块覆盖的原始已选需求网段（按地址升序） */
  sources: SummarySource[]
}

export interface RouteSummary {
  /** 汇总 CIDR（按网络地址升序） */
  blocks: SummaryBlock[]
  /** 汇总覆盖的总地址数（= 所选网段地址数之和，无重复） */
  totalAddresses: number
  selectedCount: number
}

interface MergedRange {
  start: number
  end: number
  /** 构成该并集区间的原网段（按地址升序） */
  owners: SummarySource[]
}

function toSource(seg: Segment): SummarySource | null {
  if ((seg.kind !== 'fixed' && seg.kind !== 'auto') || !seg.ownerId) return null
  return {
    id: seg.ownerId,
    name: seg.name,
    cidr: seg.cidr,
    kind: seg.kind,
    start: seg.start,
    end: seg.end,
    capacity: seg.capacity,
  }
}

/** 取 n 的最低位 1 的权值：n>0 时它正是以 n 为起点可对齐的最大 CIDR 块；n=0 时为 2^32（/0） */
function lowbit(n: number): number {
  return n === 0 ? 4294967296 : (n & -n) >>> 0
}

/** 合并端点相接（或防御性重叠）的相邻区间，同时保留构成每个并集的原网段 */
function mergeAdjacent(segs: SummarySource[]): MergedRange[] {
  const sorted = [...segs].sort((a, b) => a.start - b.start || a.end - b.end)
  const ranges: MergedRange[] = []
  for (const seg of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && seg.start <= last.end + 1) {
      last.end = Math.max(last.end, seg.end)
      last.owners.push(seg)
    } else {
      ranges.push({ start: seg.start, end: seg.end, owners: [seg] })
    }
  }
  return ranges
}

interface RawBlock {
  network: number
  prefix: number
  size: number
}

/**
 * 单个连续整数区间 -> 数量最少的对齐 CIDR 块（经典 range→CIDR 贪心）：
 * 每一步从游标起，取「不超过区间剩余长度」的最大 2 的幂对齐块，直到区间耗尽。
 * 结果块数最少，且并集与原区间严格相等（不多一个地址，也不少一个地址）。
 */
function decomposeRange(start: number, end: number): RawBlock[] {
  const blocks: RawBlock[] = []
  let cursor = start
  while (cursor <= end) {
    let size = lowbit(cursor)
    const remaining = end - cursor + 1
    while (size > remaining) size /= 2
    blocks.push({
      network: cursor >>> 0,
      prefix: size === 4294967296 ? 0 : 1 + Math.clz32(size),
      size,
    })
    cursor += size
  }
  return blocks
}

/**
 * 将勾选的已分配网段汇总为最少且精确覆盖的 CIDR 列表（按网络地址升序）。
 * 输入应为同一次规划结果中成功分配的 fixed/auto 网段（规划保证彼此互不重叠且均为对齐 CIDR）。
 */
export function summarizeSegments(segments: Segment[]): RouteSummary {
  const selected: SummarySource[] = []
  for (const seg of segments) {
    const src = toSource(seg)
    if (src) selected.push(src)
  }

  const blocks: SummaryBlock[] = []
  for (const range of mergeAdjacent(selected)) {
    // 原网段均为对齐 CIDR：合并区间再按边界拆分时，每个原网段都会完整落入唯一一个结果块
    // （对齐块的起点不会落在另一对齐块内部），因此按地址游标归集 owners 即可。
    let ownerIdx = 0
    for (const raw of decomposeRange(range.start, range.end)) {
      const blockEnd = raw.network + raw.size - 1
      const sources: SummarySource[] = []
      while (ownerIdx < range.owners.length && range.owners[ownerIdx].start <= blockEnd) {
        sources.push(range.owners[ownerIdx])
        ownerIdx++
      }
      blocks.push({
        cidr: `${intToIp(raw.network)}/${raw.prefix}`,
        network: raw.network,
        prefix: raw.prefix,
        capacity: raw.size,
        aggregated: sources.length > 1,
        sources,
      })
    }
  }

  blocks.sort((a, b) => a.network - b.network || a.prefix - b.prefix)
  const totalAddresses = blocks.reduce((acc, b) => acc + b.capacity, 0)
  return { blocks, totalAddresses, selectedCount: selected.length }
}

/** 复制用输出：按网络地址升序的纯 CIDR 文本，每行一个 */
export function blocksToCidrList(blocks: SummaryBlock[]): string {
  return blocks.map((b) => b.cidr).join('\n')
}
