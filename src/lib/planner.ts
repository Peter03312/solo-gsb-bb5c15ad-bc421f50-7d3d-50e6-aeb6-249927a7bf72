import {
  alignTo,
  blockSize,
  formatCidr,
  intToIp,
  parseCidr,
  prefixForHosts,
  type ParsedCidr,
} from './ip'
import type {
  Baseline,
  BaselineEntry,
  FailureItem,
  PlanResult,
  PlannerInput,
  ReflowCandidate,
  ReflowReport,
  ReflowRow,
  ReflowStatus,
  RequirementInput,
  ReservedInput,
  Segment,
} from './types'

interface Interval {
  start: number
  end: number
}

interface Occupied extends Interval {
  kind: 'reserved' | 'fixed' | 'auto'
  name: string
  prefix: number
  network: number
  requestedHosts?: number
  ownerId?: string
  /** 重排模式：本段是否经优先候选（包含基线网络地址的对齐块）落位 */
  anchored?: boolean
}

interface Gap extends Interval {
  length: number
}

/** 计算已占用区间之外、按父网段边界裁剪后的全部空闲间隙（按地址升序） */
function computeGaps(parentStart: number, parentEnd: number, occupied: Interval[]): Gap[] {
  const sorted = [...occupied].sort((a, b) => a.start - b.start || a.end - b.end)
  const gaps: Gap[] = []
  let cursor = parentStart
  for (const iv of sorted) {
    if (iv.end < cursor) continue // 完全包含在已处理区间内
    const start = Math.max(cursor, iv.start)
    if (start > cursor) {
      gaps.push({ start: cursor, end: start - 1, length: start - cursor })
    }
    cursor = Math.max(cursor, iv.end + 1)
    if (cursor > parentEnd) break
  }
  if (cursor <= parentEnd) {
    gaps.push({ start: cursor, end: parentEnd, length: parentEnd - cursor + 1 })
  }
  return gaps
}

function usableOf(size: number): number {
  return size >= 4 ? size - 2 : 0
}

function describeRange(network: number, size: number, broadcast: number) {
  if (size < 4) {
    // /31、/32 无标准意义上的可用主机地址
    return { firstUsable: '—', lastUsable: '—', usable: 0 }
  }
  return {
    firstUsable: intToIp(network + 1),
    lastUsable: intToIp(broadcast - 1),
    usable: size - 2,
  }
}

function toSegment(oc: Occupied): Segment {
  const size = blockSize(oc.prefix)
  const broadcast = oc.prefix === 32 ? oc.network : oc.network + size - 1
  const { firstUsable, lastUsable, usable } = describeRange(oc.network, size, broadcast)
  const waste =
    oc.requestedHosts !== undefined ? Math.max(0, usable - oc.requestedHosts) : 0
  return {
    kind: oc.kind,
    name: oc.name,
    cidr: formatCidr(oc.network, oc.prefix),
    prefix: oc.prefix,
    network: intToIp(oc.network),
    broadcast: intToIp(broadcast),
    firstUsable,
    lastUsable,
    start: oc.network,
    end: broadcast,
    capacity: size,
    usable,
    waste,
    requestedHosts: oc.requestedHosts,
    ownerId: oc.ownerId,
    baselineAnchored: oc.anchored,
  }
}

function freeSegment(gap: Gap): Segment {
  return {
    kind: 'free',
    name: '空闲',
    cidr: `${intToIp(gap.start)} – ${intToIp(gap.end)}`,
    prefix: -1,
    network: intToIp(gap.start),
    broadcast: intToIp(gap.end),
    firstUsable: '—',
    lastUsable: '—',
    start: gap.start,
    end: gap.end,
    capacity: gap.length,
    usable: gap.length,
    waste: 0,
  }
}

function overlap(a: Interval, b: Interval): boolean {
  return a.start <= b.end && b.start <= a.end
}

interface ParsedFixed {
  req: RequirementInput
  parsed: ParsedCidr
  hosts: number
}

interface AutoItem {
  req: RequirementInput
  hosts: number
  /** 录入顺序（需求列表中的下标） */
  index: number
}

/** 在保留区/固定段/已分配段之外，取最低的满足前缀边界对齐的空闲块；放不下返回 null */
function placeLowest(
  parentStart: number,
  parentEnd: number,
  occupied: Interval[],
  prefix: number,
  size: number,
): { start: number } | null {
  const gaps = computeGaps(parentStart, parentEnd, occupied)
  for (const gap of gaps) {
    if (gap.length < size) continue
    // 间隙内第一个满足前缀边界对齐的地址（对齐结果若落在间隙之前则推进一个块）
    let alignedStart = alignTo(gap.start, prefix)
    if (alignedStart < gap.start) alignedStart += size
    if (alignedStart + size - 1 <= gap.end) {
      return { start: alignedStart >>> 0 } // 最低对齐空闲地址（间隙已按地址升序）
    }
  }
  return null
}

/** 放不下时的失败原因（最大连续空闲块 / 边界对齐不满足） */
function describeFailure(
  parentStart: number,
  parentEnd: number,
  occupied: Interval[],
  prefix: number,
  size: number,
): string {
  const gapsNow = computeGaps(parentStart, parentEnd, occupied)
  const maxGap = gapsNow.reduce((m, g) => Math.max(m, g.length), 0)
  if (maxGap < size) {
    return `需要至少 ${size} 个连续地址（/${prefix}，可用 ${usableOf(size)} 台），当前最大连续空闲块仅 ${maxGap} 个地址`
  }
  return `空闲块虽有 ${maxGap} 个地址，但不存在满足 /${prefix} 边界对齐的 ${size} 地址空间`
}

/* ---------- 基线优先重排 ---------- */

interface AnchorItem extends AutoItem {
  baseline: BaselineEntry
  prefix: number
  size: number
  /** 包含基线网络地址的对齐块起点（优先候选） */
  anchorStart: number
}

interface AnchorDecision {
  item: AnchorItem
  candidate: ReflowCandidate
  accepted: boolean
}

export function plan(input: PlannerInput): PlanResult {
  const inputErrors: string[] = []
  const occupied: Occupied[] = []

  // 1) 解析并校验父网段
  const parentRaw = input.parentCidr.trim()
  if (!parentRaw) {
    inputErrors.push('请填写父 CIDR（例如 192.168.1.0/24）')
  }
  const parentParsed = parentRaw ? parseCidr(parentRaw, true) : null
  if (parentParsed && 'error' in parentParsed) {
    inputErrors.push(`父网段无效：${parentParsed.error}`)
  }
  const parent = parentParsed && !('error' in parentParsed) ? parentParsed : null
  const parentStart = parent ? parent.network : 0
  const parentEnd = parent ? parent.broadcast : 0
  const parentSize = parent ? parent.size : 0

  const withinParent = (s: number, e: number) =>
    parent !== null && s >= parentStart && e <= parentEnd

  // 2) 解析保留区
  const reservedItems: { item: ReservedInput; parsed: ParsedCidr }[] = []
  for (const r of input.reservations) {
    if (!r.cidr.trim() && !r.name.trim()) continue
    if (!r.cidr.trim()) {
      inputErrors.push(`保留区“${r.name || '未命名'}”缺少 CIDR`)
      continue
    }
    const parsed = parseCidr(r.cidr, true)
    if ('error' in parsed) {
      inputErrors.push(`保留区“${r.name || r.cidr}”无效：${parsed.error}`)
      continue
    }
    if (parent && !withinParent(parsed.network, parsed.broadcast)) {
      inputErrors.push(
        `保留区“${r.name || r.cidr}”（${formatCidr(parsed.network, parsed.prefix)}）不在父网段 ${parentRaw} 内`,
      )
      continue
    }
    reservedItems.push({ item: r, parsed })
  }

  // 3) 解析需求：固定网段 vs 自动网段
  const fixedItems: ParsedFixed[] = []
  const autoItems: AutoItem[] = []
  for (let index = 0; index < input.requirements.length; index++) {
    const req = input.requirements[index]
    if (req.name.trim() === '' && req.hosts === '' && req.cidr.trim() === '') continue
    const label = req.name || '未命名需求'
    if (req.hosts === '' || !Number.isInteger(req.hosts) || req.hosts <= 0) {
      inputErrors.push(`需求“${label}”的主机数无效（需为大于 0 的整数）`)
      continue
    }
    const hosts = req.hosts
    if (req.cidr.trim() !== '') {
      const parsed = parseCidr(req.cidr, true)
      if ('error' in parsed) {
        inputErrors.push(`需求“${label}”的固定网段无效：${parsed.error}`)
        continue
      }
      if (parent && !withinParent(parsed.network, parsed.broadcast)) {
        inputErrors.push(
          `需求“${label}”的固定网段 ${formatCidr(parsed.network, parsed.prefix)} 不在父网段 ${parentRaw} 内`,
        )
        continue
      }
      const usable = usableOf(parsed.size)
      if (usable < hosts) {
        inputErrors.push(
          `需求“${label}”需要 ${hosts} 台主机，但固定网段 ${formatCidr(parsed.network, parsed.prefix)} 仅提供 ${usable} 个可用地址（总容量 ${parsed.size}）`,
        )
        continue
      }
      fixedItems.push({ req, parsed, hosts })
    } else {
      autoItems.push({ req, hosts, index })
    }
  }

  // 4) 保留区与固定网段两两互不重叠（任一非法即终止，避免区间不可信）
  if (parent) {
    const claims: { label: string; iv: Interval }[] = [
      ...reservedItems.map(({ item, parsed }) => ({
        label: `保留区“${item.name || formatCidr(parsed.network, parsed.prefix)}”`,
        iv: { start: parsed.network, end: parsed.broadcast },
      })),
      ...fixedItems.map(({ req, parsed }) => ({
        label: `需求“${req.name || formatCidr(parsed.network, parsed.prefix)}”的固定网段`,
        iv: { start: parsed.network, end: parsed.broadcast },
      })),
    ]
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        if (overlap(claims[i].iv, claims[j].iv)) {
          inputErrors.push(`${claims[i].label}与${claims[j].label}地址重叠`)
        }
      }
    }
  }

  // 基线优先重排仅在「存在基线 + 父网段与基线一致 + 输入合法」时实际生效；
  // 父网段变化或无基线时由上层禁用该模式，此处理论上不会拿到 baseline。
  const parentCidrCanonical = parent ? formatCidr(parent.network, parent.prefix) : ''
  const reflowActive = !!parent && !!input.baseline && input.baseline.parentCidr === parentCidrCanonical

  if (!parent || inputErrors.length > 0) {
    return {
      parentCidr: parentRaw,
      parentNetwork: parent ? intToIp(parent.network) : '',
      parentPrefix: parent ? parent.prefix : -1,
      parentSize,
      segments: [],
      failures: [],
      inputErrors,
      summary: emptySummary(parent),
    }
  }

  // 占用区：保留区 + 固定网段
  for (const { item, parsed } of reservedItems) {
    occupied.push({
      kind: 'reserved',
      name: item.name || formatCidr(parsed.network, parsed.prefix),
      prefix: parsed.prefix,
      network: parsed.network,
      start: parsed.network,
      end: parsed.broadcast,
      ownerId: item.id,
    })
  }
  for (const { req, parsed, hosts } of fixedItems) {
    occupied.push({
      kind: 'fixed',
      name: req.name || formatCidr(parsed.network, parsed.prefix),
      prefix: parsed.prefix,
      network: parsed.network,
      start: parsed.network,
      end: parsed.broadcast,
      requestedHosts: hosts,
      ownerId: req.id,
    })
  }

  // 5) 自动需求
  const failures: FailureItem[] = []

  // 每个自动需求最终落位的跟踪（重排模式下用于生成重排报告）
  const anchoredOwners = new Set<string>()
  // 基线中「曾成功分配的自动需求」按稳定 ID 索引（重排模式专用）
  const baselineById = reflowActive
    ? new Map(input.baseline!.entries.filter((e) => e.state === 'allocated').map((e) => [e.id, e]))
    : null

  /** 最低对齐策略：按规模从大到小、同规模按录入顺序，为每个需求取最低对齐空闲块 */
  function allocateLowest(items: AutoItem[], rejectReasons?: Map<string, string>) {
    const ordered = items.slice().sort((a, b) => {
      const pa = prefixForHosts(a.hosts)
      const pb = prefixForHosts(b.hosts)
      return pa - pb || a.index - b.index
    })
    for (const { req, hosts } of ordered) {
      placeAuto(req, hosts, false, undefined, rejectReasons?.get(req.id))
    }
  }

  /** 放置一个自动需求（anchored=true 表示经基线优先候选落位）；失败记入 failures */
  function placeAuto(
    req: RequirementInput,
    hosts: number,
    anchored: boolean,
    forcedStart?: number,
    rejectReason?: string,
  ) {
    const prefix = prefixForHosts(hosts)
    const size = blockSize(prefix)
    const label = req.name || '未命名需求'

    if (size < hosts + 2) {
      failures.push({
        id: req.id,
        name: label,
        hosts,
        reason: `需要 ${hosts} 台主机，超过 IPv4 最大单网段可用容量 4294967294（/0）`,
      })
      return
    }

    let placed: { start: number } | null = null
    if (forcedStart !== undefined) {
      // 优先候选的可行性已在候选筛选阶段确认（含与已采纳候选互不冲突）
      placed = { start: forcedStart >>> 0 }
    } else {
      placed = placeLowest(parentStart, parentEnd, occupied, prefix, size)
    }

    if (!placed) {
      const detail = describeFailure(parentStart, parentEnd, occupied, prefix, size)
      failures.push({
        id: req.id,
        name: label,
        hosts,
        // 重排模式下优先候选被拒时，在失败原因中标明候选与不可行原因
        reason: rejectReason ? `${rejectReason}；${detail}` : detail,
      })
      return
    }

    occupied.push({
      kind: 'auto',
      name: label,
      prefix,
      network: placed.start,
      start: placed.start,
      end: placed.start + size - 1,
      requestedHosts: hosts,
      ownerId: req.id,
      anchored,
    })
    if (anchored) anchoredOwners.add(req.id)
  }

  /** 基线优先重排：构造优先候选、按规模/录入顺序贪心保留，其余需求再走最低对齐策略 */
  function allocateWithReflow() {
    const anchorItems: AnchorItem[] = []
    // 不产生优先候选的基线自动需求（如基线时未分配），按状态在报告中说明
    const skippedAuto = new Map<string, { baseline: BaselineEntry; status: ReflowStatus }>()

    for (const item of autoItems) {
      const old = baselineById!.get(item.req.id)
      if (!old) continue // 基线中不存在：新增需求
      if (old.kind !== 'auto') {
        // 基线时是固定网段、当前改为自动：原址归属固定段语义，不做原址优先
        skippedAuto.set(item.req.id, { baseline: old, status: 'baseline-fixed' })
        continue
      }
      if (old.start === undefined) {
        skippedAuto.set(item.req.id, { baseline: old, status: 'baseline-failed' })
        continue
      }
      const prefix = prefixForHosts(item.hosts)
      const size = blockSize(prefix)
      if (size < item.hosts + 2) continue // 超过 /0 可用容量：无意义候选，交由最低对齐路径记失败
      // 包含原网络地址的对齐块：目标前缀下 old.start 所在的块即唯一候选
      const anchorStart = alignTo(old.start, prefix)
      anchorItems.push({ ...item, baseline: old, prefix, size, anchorStart })
    }

    // 候选越界、撞保留区或固定段、彼此冲突时：
    // 按所需地址数从大到小、同规模按录入顺序保留可行候选（一次遍历贪心）
    const decisions: AnchorDecision[] = []
    const orderedCandidates = anchorItems
      .slice()
      .sort((a, b) => b.size - a.size || a.index - b.index)

    for (const item of orderedCandidates) {
      const cStart = item.anchorStart
      const cEnd = cStart + item.size - 1
      let reason: string | undefined
      if (cStart < parentStart || cEnd > parentEnd) {
        reason = `对齐块 ${formatCidr(cStart, item.prefix)} 越出父网段 ${parentCidrCanonical}`
      } else {
        // 保留区与固定段（静态占用）；已采纳的优先候选彼此冲突也算
        for (const oc of occupied) {
          if (overlap({ start: cStart, end: cEnd }, oc)) {
            const who =
              oc.kind === 'reserved'
                ? `保留区“${oc.name}”`
                : oc.kind === 'fixed'
                  ? `需求“${oc.name}”的固定网段`
                  : `已保留原址的需求“${oc.name}”的候选块`
            reason = `对齐块 ${formatCidr(cStart, item.prefix)} 与${who} ${formatCidr(
              oc.network,
              oc.prefix,
            )} 冲突`
            break
          }
        }
      }
      const candidate: ReflowCandidate = {
        cidr: formatCidr(cStart, item.prefix),
        accepted: reason === undefined,
        ...(reason ? { reason } : {}),
      }
      decisions.push({ item, candidate, accepted: reason === undefined })
      if (reason === undefined) {
        // 立即占位（强制落在候选起点），使后续（更小或更晚录入的）候选感知冲突
        placeAuto(item.req, item.hosts, true, cStart)
      }
    }

    // 被拒绝候选的需求 + 无候选需求（新增/基线固定/基线失败）走既有最低对齐策略
    const acceptedOwners = new Set(
      decisions.filter((d) => d.accepted).map((d) => d.item.req.id),
    )
    // 被拒候选的不可行原因（含候选 CIDR），失败时并入失败原因
    const rejectReasons = new Map<string, string>(
      decisions
        .filter((d) => !d.accepted)
        .map((d) => [
          d.item.req.id,
          `基线优先候选 ${d.candidate.cidr} 不可行：${d.candidate.reason ?? ''}`.replace(/：$/, ''),
        ]),
    )
    const rest = autoItems.filter(
      (item) => !acceptedOwners.has(item.req.id) && !anchoredOwners.has(item.req.id),
    )
    allocateLowest(rest, rejectReasons)

    return { decisions, skippedAuto }
  }

  let reflowData: { decisions: AnchorDecision[]; skippedAuto: Map<string, { baseline: BaselineEntry; status: ReflowStatus }> } | null =
    null
  if (reflowActive) {
    reflowData = allocateWithReflow()
  } else {
    // 5) 自动需求：从大到小（前缀小者优先），同规模按录入顺序
    allocateLowest(autoItems)
  }

  // 6) 生成最终网段序列（占用 + 空闲，按地址排序）
  const segments: Segment[] = []
  const occSegments = occupied.sort((a, b) => a.start - b.start).map(toSegment)

  // 重排模式：为每个自动网段标注最终落点相对基线原址的结果
  if (reflowActive) {
    for (const seg of occSegments) {
      if (seg.kind !== 'auto' || !seg.ownerId) continue
      const old = baselineById!.get(seg.ownerId)
      if (old && old.state === 'allocated' && old.kind === 'auto' && old.start !== undefined) {
        seg.baselineOutcome = seg.start === old.start ? 'kept' : 'moved'
      }
    }
  }

  const finalGaps = computeGaps(parentStart, parentEnd, occupied)
  let gi = 0
  for (const seg of occSegments) {
    while (gi < finalGaps.length && finalGaps[gi].end < seg.start) {
      segments.push(freeSegment(finalGaps[gi]))
      gi++
    }
    segments.push(seg)
  }
  while (gi < finalGaps.length) {
    segments.push(freeSegment(finalGaps[gi]))
    gi++
  }

  // 7) 统计
  const sumCapacity = (k: Segment['kind']) =>
    segments.filter((s) => s.kind === k).reduce((acc, s) => acc + s.capacity, 0)
  const reservedCap = sumCapacity('reserved')
  const fixedCap = sumCapacity('fixed')
  const autoCap = sumCapacity('auto')
  const freeCap = sumCapacity('free')
  const allocatedUsable = segments
    .filter((s) => s.kind === 'auto' || s.kind === 'fixed')
    .reduce((acc, s) => acc + s.usable, 0)
  const requestedHosts = segments
    .filter((s) => s.kind === 'auto' || s.kind === 'fixed')
    .reduce((acc, s) => acc + (s.requestedHosts ?? 0), 0)
  const waste = segments
    .filter((s) => s.kind === 'auto' || s.kind === 'fixed')
    .reduce((acc, s) => acc + s.waste, 0)

  const reflow = reflowActive
    ? buildReflowReport({
        baseline: input.baseline!,
        autoItems,
        fixedIds: new Set(fixedItems.map((f) => f.req.id)),
        segments,
        failures,
        decisions: reflowData!.decisions,
        skippedAuto: reflowData!.skippedAuto,
      })
    : undefined

  return {
    parentCidr: formatCidr(parent.network, parent.prefix),
    parentNetwork: intToIp(parent.network),
    parentPrefix: parent.prefix,
    parentSize,
    segments,
    failures,
    inputErrors,
    reflow,
    summary: {
      reserved: reservedCap,
      fixed: fixedCap,
      auto: autoCap,
      free: freeCap,
      totalCapacity: parentSize,
      usedCapacity: reservedCap + fixedCap + autoCap,
      allocatedUsable,
      requestedHosts,
      waste,
      utilization: parentSize === 0 ? 0 : ((reservedCap + fixedCap + autoCap) / parentSize) * 100,
    },
  }
}

function emptySummary(parent: ParsedCidr | null): PlanResult['summary'] {
  return {
    reserved: 0,
    fixed: 0,
    auto: 0,
    free: 0,
    totalCapacity: parent ? parent.size : 0,
    usedCapacity: 0,
    allocatedUsable: 0,
    requestedHosts: 0,
    waste: 0,
    utilization: 0,
  }
}

/* ---------- 基线优先重排报告 ---------- */

interface ReflowReportInput {
  baseline: Baseline
  autoItems: AutoItem[]
  fixedIds: Set<string>
  segments: Segment[]
  failures: FailureItem[]
  decisions: AnchorDecision[]
  skippedAuto: Map<string, { baseline: BaselineEntry; status: ReflowStatus }>
}

const REFLOW_STATUS_META: Record<ReflowStatus, { count: keyof ReflowReport['counts'] | null }> = {
  kept: { count: 'kept' },
  moved: { count: 'moved' },
  'fallback-kept': { count: 'fallbackKept' },
  'fallback-moved': { count: 'fallbackMoved' },
  failed: { count: 'failed' },
  'fixed-untouched': { count: 'skipped' },
  'became-fixed': { count: 'skipped' },
  'baseline-fixed': { count: 'skipped' },
  'baseline-failed': { count: null },
  new: { count: 'new' },
}

function buildReflowReport(input: ReflowReportInput): ReflowReport {
  const { baseline, autoItems, fixedIds, segments, failures, decisions, skippedAuto } = input
  const rows: ReflowRow[] = []

  const segByOwner = new Map(
    segments
      .filter((s) => (s.kind === 'auto' || s.kind === 'fixed') && s.ownerId)
      .map((s) => [s.ownerId!, s]),
  )
  const failById = new Map(failures.map((f) => [f.id, f]))
  const decisionByOwner = new Map(decisions.map((d) => [d.item.req.id, d]))
  // 基线全部条目（含未分配），用于区分「基线失败」与「新增」
  const baselineById = new Map(baseline.entries.map((e) => [e.id, e]))

  // 1) 当前固定网段需求：固定段位置由用户指定，不参与自动重排
  for (const id of fixedIds) {
    const seg = segByOwner.get(id)
    const old = baselineById.get(id)
    if (!old) continue // 基线保存后新增的固定需求不在重排报告中逐列
    rows.push({
      id,
      name: seg?.name ?? old.name,
      hosts: seg?.requestedHosts ?? old.hosts ?? 0,
      status: old.state === 'allocated' && old.kind === 'fixed' ? 'fixed-untouched' : 'became-fixed',
      baselineCidr: old.state === 'allocated' ? old.cidr : undefined,
      currentCidr: seg?.cidr,
    })
  }

  // 2) 当前自动需求
  for (const item of autoItems) {
    const { req, hosts } = item
    const old = baselineById.get(req.id)
    const seg = segByOwner.get(req.id)
    const fail = failById.get(req.id)
    const skipped = skippedAuto.get(req.id)
    const decision = decisionByOwner.get(req.id)
    const base: Omit<ReflowRow, 'status' | 'currentCidr' | 'baselineCidr' | 'reason' | 'candidate'> = {
      id: req.id,
      name: req.name || '未命名需求',
      hosts,
    }

    if (fail) {
      // 失败原因已在 placeAuto 中并入候选不可行说明，直接透传
      rows.push({
        ...base,
        status: 'failed',
        baselineCidr: old?.state === 'allocated' ? old.cidr : undefined,
        reason: fail.reason,
        candidate: decision?.candidate,
      })
      continue
    }

    if (!seg) continue // 防御：既无成功网段也无失败记录（理论上不发生）

    if (!old) {
      rows.push({ ...base, status: 'new', currentCidr: seg.cidr })
      continue
    }

    if (old.state === 'allocated' && old.kind !== 'auto') {
      // 基线时为固定网段、当前改为自动需求
      rows.push({
        ...base,
        status: 'baseline-fixed',
        baselineCidr: old.cidr,
        currentCidr: seg.cidr,
      })
      continue
    }

    if (skipped?.status === 'baseline-failed' || old.state === 'unallocated' || old.start === undefined) {
      // 基线时未分配，无原址可保留
      rows.push({
        ...base,
        status: 'baseline-failed',
        currentCidr: seg.cidr,
      })
      continue
    }

    const kept = seg.start === old.start
    if (decision?.accepted) {
      rows.push({
        ...base,
        status: kept ? 'kept' : 'moved',
        baselineCidr: old.cidr,
        currentCidr: seg.cidr,
        candidate: decision.candidate,
      })
    } else {
      rows.push({
        ...base,
        status: kept ? 'fallback-kept' : 'fallback-moved',
        baselineCidr: old.cidr,
        currentCidr: seg.cidr,
        candidate: decision?.candidate,
      })
    }
  }

  // 统计（按录入顺序展示行，计数独立汇总）
  const counts: ReflowReport['counts'] = {
    kept: 0,
    moved: 0,
    fallbackKept: 0,
    fallbackMoved: 0,
    failed: 0,
    skipped: 0,
    new: 0,
  }
  let anchorsAccepted = 0
  let anchorsRejected = 0
  for (const row of rows) {
    const key = REFLOW_STATUS_META[row.status].count
    if (key) counts[key] += 1
  }
  for (const d of decisions) {
    if (d.accepted) anchorsAccepted += 1
    else anchorsRejected += 1
  }

  return { active: true, rows, counts, anchorsAccepted, anchorsRejected }
}
