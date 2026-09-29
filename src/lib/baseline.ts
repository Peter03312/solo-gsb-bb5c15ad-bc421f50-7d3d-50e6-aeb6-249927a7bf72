import { intToIp } from './ip'
import type {
  AddrRange,
  Baseline,
  BaselineComparison,
  BaselineEntry,
  ChangeRow,
  ChangeType,
  PlanResult,
} from './types'

const STORAGE_KEY = 'vlsm-baseline-v1'

/** 合并相交或相邻的地址区间（合并后互不重叠，按地址升序） */
export function mergeRanges(ranges: AddrRange[]): AddrRange[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: AddrRange[] = [{ ...sorted[0] }]
  for (const r of sorted.slice(1)) {
    const last = out[out.length - 1]
    if (r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end)
    } else {
      out.push({ ...r })
    }
  }
  return out
}

function intersect(a: AddrRange, b: AddrRange): AddrRange | null {
  const start = Math.max(a.start, b.start)
  const end = Math.min(a.end, b.end)
  return start <= end ? { start, end } : null
}

/** A − B：从区间集合 A 中扣除 B 覆盖的地址（A、B 均需已合并、升序） */
function subtractRanges(a: AddrRange[], b: AddrRange[]): AddrRange[] {
  const out: AddrRange[] = []
  let j = 0
  for (const range of a) {
    while (j < b.length && b[j].end < range.start) j++
    let cursor = range.start
    for (let k = j; k < b.length && b[k].start <= range.end; k++) {
      const cut = b[k]
      if (cut.start > cursor) out.push({ start: cursor, end: Math.min(cut.start - 1, range.end) })
      cursor = Math.max(cursor, cut.end + 1)
      if (cursor > range.end) break
    }
    if (cursor <= range.end) out.push({ start: cursor, end: range.end })
  }
  return out
}

const rangeSize = (r: AddrRange) => r.end - r.start + 1
const sumSize = (rs: AddrRange[]) => rs.reduce((acc, r) => acc + rangeSize(r), 0)

/** 从一次无输入错误的规划结果构建基线快照 */
export function buildBaseline(result: PlanResult): Baseline {
  const entries: BaselineEntry[] = []

  for (const seg of result.segments) {
    if ((seg.kind !== 'fixed' && seg.kind !== 'auto') || !seg.ownerId) continue
    entries.push({
      id: seg.ownerId,
      name: seg.name,
      state: 'allocated',
      cidr: seg.cidr,
      start: seg.start,
      end: seg.end,
      prefix: seg.prefix,
      capacity: seg.capacity,
      usable: seg.usable,
      hosts: seg.requestedHosts,
      kind: seg.kind,
    })
  }
  for (const f of result.failures) {
    entries.push({
      id: f.id,
      name: f.name,
      state: 'unallocated',
      hosts: f.hosts,
      reason: f.reason,
    })
  }

  entries.sort((a, b) => a.id.localeCompare(b.id))

  return {
    createdAt: new Date().toISOString(),
    parentCidr: result.parentCidr,
    parentStart: result.segments.length
      ? Math.min(...result.segments.map((s) => s.start))
      : Number.NaN,
    parentEnd: result.segments.length
      ? Math.max(...result.segments.map((s) => s.end))
      : Number.NaN,
    parentSize: result.parentSize,
    entries,
    occupiedRanges: mergeRanges(
      result.segments
        .filter((s) => s.kind !== 'free')
        .map((s) => ({ start: s.start, end: s.end })),
    ),
  }
}

/** 当前规划中各需求的状态（已分配网段 / 分配失败） */
function currentEntries(result: PlanResult): Map<string, BaselineEntry> {
  const map = new Map<string, BaselineEntry>()
  for (const seg of result.segments) {
    if ((seg.kind !== 'fixed' && seg.kind !== 'auto') || !seg.ownerId) continue
    map.set(seg.ownerId, {
      id: seg.ownerId,
      name: seg.name,
      state: 'allocated',
      cidr: seg.cidr,
      start: seg.start,
      end: seg.end,
      prefix: seg.prefix,
      capacity: seg.capacity,
      usable: seg.usable,
      hosts: seg.requestedHosts,
      kind: seg.kind,
    })
  }
  for (const f of result.failures) {
    map.set(f.id, {
      id: f.id,
      name: f.name,
      state: 'unallocated',
      hosts: f.hosts,
      reason: f.reason,
    })
  }
  return map
}

const CHANGE_ORDER: ChangeType[] = [
  'removed',
  'migrated',
  'resized',
  'unallocated',
  'recovered',
  'added',
  'still-unallocated',
  'unchanged',
]

/** 按需求稳定 ID 对比基线与当前规划，并汇总地址区间变化 */
export function compareWithBaseline(
  baseline: Baseline,
  result: PlanResult,
): BaselineComparison {
  const current = currentEntries(result)
  const rows: ChangeRow[] = []

  for (const old of baseline.entries) {
    const now = current.get(old.id)
    if (!now) {
      rows.push({ type: 'removed', id: old.id, name: old.name, baseline: old, hosts: old.hosts })
      continue
    }
    const base: Omit<ChangeRow, 'type'> = {
      id: old.id,
      name: now.name || old.name,
      baseline: old,
      current: now,
      hosts: now.hosts ?? old.hosts,
    }
    if (old.state === 'allocated' && now.state === 'allocated') {
      const sameCidr = old.cidr === now.cidr
      const resize =
        old.capacity !== now.capacity
          ? (now.capacity! > old.capacity! ? 'grow' : 'shrink')
          : undefined
      if (sameCidr && !resize) {
        rows.push({ ...base, type: 'unchanged' })
      } else if (sameCidr) {
        rows.push({ ...base, type: 'resized', resize })
      } else {
        rows.push({ ...base, type: 'migrated', resize })
      }
    } else if (old.state === 'allocated' && now.state === 'unallocated') {
      rows.push({ ...base, type: 'unallocated' })
    } else if (old.state === 'unallocated' && now.state === 'allocated') {
      rows.push({ ...base, type: 'recovered' })
    } else {
      rows.push({ ...base, type: 'still-unallocated' })
    }
  }

  for (const now of current.values()) {
    if (baseline.entries.some((e) => e.id === now.id)) continue
    rows.push({ type: 'added', id: now.id, name: now.name, current: now, hosts: now.hosts })
  }

  rows.sort(
    (a, b) =>
      CHANGE_ORDER.indexOf(a.type) - CHANGE_ORDER.indexOf(b.type) ||
      a.name.localeCompare(b.name, 'zh-Hans-CN') ||
      a.id.localeCompare(b.id),
  )

  const counts = Object.fromEntries(
    CHANGE_ORDER.map((t) => [t, rows.filter((r) => r.type === t).length]),
  ) as Record<ChangeType, number>

  // 地址区间汇总（基线占用 vs 当前占用，重叠部分只计一次）
  const oldRanges = mergeRanges(baseline.occupiedRanges)
  const newRanges = mergeRanges(
    result.segments
      .filter((s) => s.kind !== 'free')
      .map((s) => ({ start: s.start, end: s.end })),
  )
  const still = mergeRanges(
    oldRanges.flatMap((o) =>
      newRanges.map((n) => intersect(o, n)).filter((x): x is AddrRange => x !== null),
    ),
  )
  const occupied = subtractRanges(newRanges, oldRanges)
  const released = subtractRanges(oldRanges, newRanges)
  const occupiedCount = sumSize(occupied)
  const releasedCount = sumSize(released)

  return {
    baseline,
    rows,
    counts,
    summary: {
      occupied,
      released,
      still,
      occupiedCount,
      releasedCount,
      stillCount: sumSize(still),
      net: occupiedCount - releasedCount,
    },
    hasChanges:
      rows.some((r) => r.type !== 'unchanged') ||
      occupiedCount !== 0 ||
      releasedCount !== 0,
  }
}

export function formatRange(r: AddrRange): string {
  return r.start === r.end
    ? intToIp(r.start)
    : `${intToIp(r.start)} ~ ${intToIp(r.end)}`
}

/* ---------- 会话级持久化（sessionStorage，关闭标签页即清除） ---------- */

export function loadBaseline(): Baseline | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as Baseline
    if (
      !data ||
      typeof data.createdAt !== 'string' ||
      !Array.isArray(data.entries) ||
      !Array.isArray(data.occupiedRanges)
    ) {
      return null
    }
    return data
  } catch {
    return null
  }
}

export function saveBaseline(baseline: Baseline): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(baseline))
  } catch {
    // sessionStorage 不可用时静默失败（基线仍可在当前内存状态中使用）
  }
}

export function clearStoredBaseline(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // 忽略
  }
}
