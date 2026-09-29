// 网段类型：保留区、固定网段（带固定前缀的需求）、自动分配网段、空闲区
export type SegmentKind = 'reserved' | 'fixed' | 'auto' | 'free'

export interface RequirementInput {
  id: string
  name: string
  /** 需要的可用主机数（= 总地址数 - 2） */
  hosts: number | ''
  /** 可选固定网段，形如 192.168.1.0/28 */
  cidr: string
}

export interface ReservedInput {
  id: string
  name: string
  /** 保留区 CIDR，形如 10.0.0.0/30 */
  cidr: string
}

export interface Segment {
  kind: SegmentKind
  /** 关联的需求 / 保留区名称（空闲区为“空闲”） */
  name: string
  cidr: string
  prefix: number
  network: string
  broadcast: string
  firstUsable: string
  lastUsable: string
  start: number // 起始地址（数值，含）
  end: number // 结束地址（数值，含）
  /** 地址块总容量 2^(32-prefix) */
  capacity: number
  /** 可用主机数 = capacity - 2 */
  usable: number
  /** 浪费量 = capacity - 2 - 实际需求主机数（自动网段）；保留/固定按容量统计 */
  waste: number
  requestedHosts?: number
  /** 自动分配失败时的原因 */
  reason?: string
  /** 关联的需求 ID（fixed/auto）或保留区 ID（reserved），用于基线对比 */
  ownerId?: string
  /** 基线优先重排模式：最终落点相对基线原址的结果（仅重排生效时，自动网段有值） */
  baselineOutcome?: 'kept' | 'moved'
  /** 是否通过「包含原网络地址的对齐块」优先候选落位（false/缺省表示走最低对齐策略） */
  baselineAnchored?: boolean
}

export interface FailureItem {
  id: string
  name: string
  hosts: number
  reason: string
}

export interface PlanResult {
  parentCidr: string
  parentNetwork: string
  parentPrefix: number
  parentSize: number
  segments: Segment[]
  failures: FailureItem[]
  /** 输入级错误（父网段、保留区、固定网段非法等），非空时 segments 不可信 */
  inputErrors: string[]
  /** 基线优先重排模式的过程与结果报告（仅该模式生效时存在） */
  reflow?: ReflowReport
  summary: {
    reserved: number
    fixed: number
    auto: number
    free: number
    totalCapacity: number
    usedCapacity: number
    allocatedUsable: number
    requestedHosts: number
    waste: number
    utilization: number // 已占用地址占父网段百分比
  }
}

export interface PlannerInput {
  parentCidr: string
  reservations: ReservedInput[]
  requirements: RequirementInput[]
  /** 启用「基线优先重排」时传入的基线（父网段与当前一致才会实际生效） */
  baseline?: Baseline | null
}

/* ---------- 基线优先重排 ---------- */

/** 重排明细行中单个需求的处置状态 */
export type ReflowStatus =
  | 'kept' // 优先候选可行，保留在原址（当前 CIDR 起点 = 基线起点）
  | 'moved' // 优先候选可行，但对齐块起点已不同于基线起点（原址容纳不下新前缀等）
  | 'fallback-kept' // 优先候选不可行，最低对齐策略恰好落在基线原址
  | 'fallback-moved' // 优先候选不可行，由最低对齐策略迁移
  | 'failed' // 优先候选与最低对齐策略均失败，无法分配
  | 'fixed-untouched' // 基线固定需求、当前仍是固定网段：不参与重排
  | 'became-fixed' // 基线自动需求（或基线未分配）、当前变成固定网段：由固定段决定，不参与重排
  | 'baseline-fixed' // 基线固定需求、当前变成自动需求：不进行原址优先
  | 'baseline-failed' // 基线时本就未分配：无原址可保留
  | 'new' // 基线保存后新增的需求：无原址，直接走最低对齐策略

export interface ReflowCandidate {
  /** 优先候选（包含基线网络地址的对齐块）CIDR */
  cidr: string
  /** 候选是否被采纳 */
  accepted: boolean
  /** 未采纳原因（越界 / 撞保留区 / 撞固定段 / 与已采纳候选冲突） */
  reason?: string
}

export interface ReflowRow {
  id: string
  name: string
  hosts: number
  status: ReflowStatus
  /** 基线时的网段 CIDR（无基线的新增需求为 undefined） */
  baselineCidr?: string
  /** 当前最终网段 CIDR（失败时为 undefined） */
  currentCidr?: string
  /** 当前失败原因（status=failed 时） */
  reason?: string
  /** 该需求的优先候选及采纳情况（仅基线自动需求存在） */
  candidate?: ReflowCandidate
}

export interface ReflowReport {
  /** 重排实际生效（基线存在、父网段一致、输入合法） */
  active: boolean
  rows: ReflowRow[]
  counts: {
    kept: number
    moved: number
    fallbackKept: number
    fallbackMoved: number
    failed: number
    skipped: number
    new: number
  }
  /** 优先候选被采纳（保留原址/在原址块内迁移）的需求数 */
  anchorsAccepted: number
  /** 优先候选被拒绝（随后走最低对齐策略或失败）的需求数 */
  anchorsRejected: number
}

/** 基线快照中的单个需求（按稳定 ID 参与对比） */
export interface BaselineEntry {
  id: string
  name: string
  /** 基线时的分配状态：已分配（固定/自动网段）或分配失败（未分配） */
  state: 'allocated' | 'unallocated'
  /** 已分配时的网段 CIDR */
  cidr?: string
  /** 已分配时的网络地址（数值） */
  start?: number
  /** 已分配时的广播地址（数值，含） */
  end?: number
  prefix?: number
  capacity?: number
  usable?: number
  hosts?: number
  kind?: 'fixed' | 'auto'
  /** 未分配时的失败原因 */
  reason?: string
}

/** 保存于当前浏览器会话的基线 */
export interface Baseline {
  createdAt: string
  parentCidr: string
  parentStart: number
  parentEnd: number
  parentSize: number
  entries: BaselineEntry[]
  /** 基线时点的全部占用区间（保留+固定+自动，已合并去重） */
  occupiedRanges: AddrRange[]
}

/** 需求级变化类型 */
export type ChangeType =
  | 'added' // 基线中不存在该需求
  | 'removed' // 基线中存在、当前已删除
  | 'unchanged' // 网段与容量均未变
  | 'resized' // CIDR 未变、容量变化（扩容/缩容）
  | 'migrated' // CIDR 改变（迁移），可能同时扩容/缩容
  | 'unallocated' // 基线已分配、当前分配失败（未分配）
  | 'recovered' // 基线分配失败、当前已分配（恢复分配）
  | 'still-unallocated' // 基线与当前均分配失败

export interface ChangeRow {
  type: ChangeType
  id: string
  name: string
  /** 容量变化方向（迁移时容量同时变化也会标记） */
  resize?: 'grow' | 'shrink'
  hosts?: number
  baseline?: BaselineEntry
  current?: BaselineEntry
}

export interface AddrRange {
  start: number
  end: number
}

export interface DiffSummary {
  /** 新占用：基线空闲、当前被占用的地址区间 */
  occupied: AddrRange[]
  /** 释放：基线占用、当前变回空闲的地址区间 */
  released: AddrRange[]
  /** 仍占用：两个时点都被占用的地址区间（重叠已合并去重） */
  still: AddrRange[]
  occupiedCount: number
  releasedCount: number
  stillCount: number
  /** 净地址变化 = 新占用 - 释放（正数表示占用增加） */
  net: number
}

export interface BaselineComparison {
  baseline: Baseline
  rows: ChangeRow[]
  counts: Record<ChangeType, number>
  summary: DiffSummary
  /** 当前相对基线是否有任何差异 */
  hasChanges: boolean
}

/* ---------- 主机地址分配 ---------- */

/** 设备地址的登记方式：自动取首个未占用地址，或手动输入 IPv4 */
export type HostAssignMode = 'auto' | 'manual'

/** 一条主机地址登记（仅随当前会话中的输入存在，不参与规划/基线/汇总/导出） */
export interface HostAssignment {
  id: string
  /** 所属需求的稳定 ID（固定/自动网段的 ownerId） */
  ownerId: string
  name: string
  /** 登记地址（数值，始终保存用户最后确认的地址，失效时也不静默改写） */
  address: number
  mode: HostAssignMode
  /** 可选 MAC（小写冒号规范格式，如 aa:bb:cc:dd:ee:ff）；缺省表示未填写，不进入 dnsmasq 输出 */
  mac?: string
}

/* ---------- DHCP 动态地址池（dnsmasq dhcp-range） ---------- */

/** 一条手工排除区间录入（仅随当前会话中的输入存在，不参与规划/基线/汇总/导出） */
export interface DhcpExclusionInput {
  /** 行内稳定 ID，规划变化或切换网段后按它原样保留录入并重新校验 */
  id: string
  /** 起始 IPv4 文本（必须位于所选网段内） */
  start: string
  /** 结束 IPv4 文本（留空表示仅排除起始单地址；不得小于起始） */
  end: string
}

/* ---------- DHCP Option 121（RFC 3442 无分类静态路由） ---------- */

/** 一条 Option 121 路由录入（仅随当前会话中的输入存在，不参与规划/基线/汇总/导出） */
export interface Option121RouteInput {
  /** 行内稳定 ID，规划变化后按它原样保留录入并重新校验 */
  id: string
  /** 目的 CIDR 文本，必须为规范网络地址，允许 0.0.0.0/0 */
  destination: string
  /** 下一跳 IPv4 文本，必须是客户端网段内的可用主机地址 */
  gateway: string
}

/* ---------- IPv4 路径分片预演（仅本地模拟 RFC 791 逐跳分片） ---------- */

/** 一跳 MTU 录入（行内稳定 ID，跳数增删 / 顺序调整后按它保留原文） */
export interface FragHopInput {
  id: string
  /** MTU 文本，合法范围 68～65535 的整数（非法时保留原文并暂停预演） */
  mtu: string
}
