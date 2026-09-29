// 迁移执行编排：基于「现有登记」与静态租约批量导入的「无冲突合并快照」，
// 生成一份按顺序执行时不会产生瞬时重复 IPv4 的逐步改址清单。
//
// 关键不变量：
//   1. 只复用 leaseImport 的无冲突结果（canApply=true）；CSV 有冲突时本模块不产生任何步骤；
//   2. 模块纯只读：不修改规划与任何登记状态，CSV / 规划 / 登记变化后由调用方重新执行即可实时重算；
//   3. 以「旧地址占用关系」建立依赖：设备 X 的目标地址当前由设备 Y 占用，则 X 依赖 Y 先迁出；
//      无环（DAG）部分按「目标地址最低优先」的可执行顺序逐步输出；
//   4. 互换或多设备环路（依赖图中的环）按「环内最小旧地址升序」【逐环】解开：
//      每环先把一台锚点设备迁到其【原网段】内最低的临时可用地址——候选只排除
//      「选址当时的全部占用」与「全部最终目标地址」；再依次完成环内改址，最后把
//      该设备从临时地址迁到目标地址并自然释放临时地址。该环完整结束后才开始下一环，
//      故已释放的临时地址可被后续独立环复用（不会被首环永久预留而误阻断后续环）；
//      某一环在选址当时没有任何一台设备能在其原网段找到临时地址时，明确阻止该环
//      （并阻止整个清单、不输出任何部分步骤）；
//   5. 新建设备（CSV 中的新 MAC）在其目标地址腾空后才能上线；目标地址被不会迁走的
//      既有设备占住时，作为阻断项明确列出。

import { intToIp } from './ip'
import { allocatableSegments, type AllocSegment } from './hosts'
import type { HostAssignment, PlanResult } from './types'
import type { LeaseImportResult } from './leaseImport'

/* ---------- 结果模型 ---------- */

/** 单步操作类型 */
export type MigrationStepKind =
  | 'temp-move' // 环：某设备先迁到原网段内的临时可用地址
  | 'move' // 设备迁到目标地址（环中非锚点设备、以及 DAG 中的普通迁移）
  | 'cycle-complete' // 环：锚点设备从临时地址迁到目标地址，临时地址随之释放
  | 'add' // 新设备上线到目标地址

export const MIGRATION_STEP_LABEL: Record<MigrationStepKind, string> = {
  'temp-move': '临时迁出',
  move: '迁移',
  'cycle-complete': '完成环路',
  add: '新增上线',
}

export interface MigrationStep {
  /** 执行序号（从 1 开始） */
  order: number
  kind: MigrationStepKind
  /** 设备稳定登记 ID（新增设备为合并快照中生成的新 ID） */
  deviceId: string
  /** 设备名（目标快照中的名称） */
  name: string
  /** 迁移前地址（临时迁出 / 普通迁移步骤） */
  fromAddress?: number
  /** 目标地址；临时迁出步骤的目标即临时地址 */
  address: number
  /** 临时地址（仅环的锚点设备的步骤存在） */
  tempAddress?: number
  /** 目标网段（设备最终所属网段）CIDR */
  targetCidr: string
  /** 临时地址所在原网段 CIDR（临时迁出步骤） */
  tempCidr?: string
  /** 该步的原因说明 */
  reason: string
}

/** 阻止生成清单的问题（占用者不会迁走 / 环路无临时地址 / 上游预览尚未就绪） */
export interface MigrationBlocker {
  kind: 'occupied' | 'no-temp' | 'pending'
  /** 相关设备名（no-temp 时为环中全部设备名） */
  devices: string[]
  address?: number
  message: string
}

/** 环（依赖强连通分量）的描述，供面板展示依赖构成 */
export interface MigrationCycle {
  /** 环中设备 ID（按依赖顺序） */
  deviceIds: string[]
  deviceNames: string[]
  /** 被选为临时锚点的设备 ID（无法找到临时地址时为 undefined） */
  pivotId?: string
  pivotName?: string
  tempAddress?: number
  tempCidr?: string
  blocked: boolean
  blockReason?: string
}

export interface MigrationPlan {
  /** 是否成功生成完整清单（false 时 steps 不完整/为空，调用方不得复制为执行依据） */
  ok: boolean
  steps: MigrationStep[]
  blockers: MigrationBlocker[]
  cycles: MigrationCycle[]
  counts: {
    moves: number // 改址设备数（不含纯新增）
    adds: number // 纯新增设备数
    cycles: number // 环路数
    tempMoves: number // 临时迁出步数
  }
  /** 参与迁移（地址发生变化）的设备总数 */
  changedDevices: number
}

/* ---------- 内部模型 ---------- */

interface DeviceView {
  id: string
  name: string
  /** 目标地址（合并快照） */
  target: number
  targetCidr: string
  /** 旧地址：既有设备为其当前地址；新增设备为 undefined */
  from?: number
  /** 旧地址是否处于任何已分配网段的可用范围内（决定能否在「原网段」找临时地址） */
  fromSegment?: AllocSegment
  isNew: boolean
  /** 旧地址失效说明（不在网段 / 网络地址 / 广播地址等），仅用于阻断文案 */
  fromInvalidReason?: string
}

/* ---------- 主入口 ---------- */

/**
 * 依据无冲突的批量导入合并快照编排逐步改址清单。
 * 调用方须保证仅在 leaseImport.canApply 为 true 时调用（否则返回 ok=false 的阻断结果）。
 */
export function buildMigrationPlan(
  imported: LeaseImportResult,
  existing: HostAssignment[],
  result: PlanResult,
): MigrationPlan {
  if (!imported.canApply) {
    return {
      ok: false,
      steps: [],
      blockers: [
        {
          kind: 'pending',
          devices: [],
          message: 'CSV 预览仍存在冲突或尚无数据行：迁移编排不产生结果，且不会改动任何登记。',
        },
      ],
      cycles: [],
      counts: { moves: 0, adds: 0, cycles: 0, tempMoves: 0 },
      changedDevices: 0,
    }
  }

  const segs = allocatableSegments(result)
  const segByOwner = new Map<string, AllocSegment>()
  for (const seg of segs) segByOwner.set(seg.ownerId, seg)

  function segmentOfAddress(addr: number): AllocSegment | undefined {
    return segs.find((s) => addr >= s.start && addr <= s.end)
  }
  /** 仅当地址位于某网段【可用主机范围】内才算该网段的合法宿主（排除网络 / 广播地址） */
  function usableSegmentOfAddress(addr: number): AllocSegment | undefined {
    return segs.find((s) => addr > s.start && addr < s.end)
  }

  // 目标快照按 ID 索引
  const existingById = new Map<string, HostAssignment>()
  for (const a of existing) existingById.set(a.id, a)

  // 当前（迁移前）物理占用：地址 -> 占用该地址的全部既有设备 ID
  //（异常重复登记也纳入，任何同址目标都必须等这些设备全部离开）
  const occupants = new Map<number, Set<string>>()
  for (const a of existing) {
    let set = occupants.get(a.address)
    if (!set) {
      set = new Set()
      occupants.set(a.address, set)
    }
    set.add(a.id)
  }

  const allTargets = new Set<number>()
  const devices: DeviceView[] = []

  for (const target of imported.merged) {
    const old = existingById.get(target.id)
    const targetSeg = segByOwner.get(target.ownerId)
    if (!targetSeg) continue // 合并快照无冲突时不会发生（目标网段必为成功分配网段）
    const view: DeviceView = {
      id: target.id,
      name: target.name,
      target: target.address,
      targetCidr: targetSeg.cidr,
      isNew: !old,
    }
    if (old) {
      view.from = old.address
      if (old.address !== target.address) {
        const seg = segmentOfAddress(old.address)
        view.fromSegment = usableSegmentOfAddress(old.address)
        if (!view.fromSegment) {
          if (seg && old.address === seg.start) view.fromInvalidReason = `原地址 ${intToIp(old.address)} 是网段 ${seg.cidr} 的网络地址`
          else if (seg && old.address === seg.end) view.fromInvalidReason = `原地址 ${intToIp(old.address)} 是网段 ${seg.cidr} 的广播地址`
          else if (seg) view.fromInvalidReason = `原地址 ${intToIp(old.address)} 不在网段 ${seg.cidr} 的可用主机范围内`
          else view.fromInvalidReason = `原地址 ${intToIp(old.address)} 不属于当前任何成功分配网段`
        }
      }
    }
    devices.push(view)
  }

  allTargets.clear()
  for (const d of devices) allTargets.add(d.target)

  const blockers: MigrationBlocker[] = []

  // 改址设备与新建设备
  const movers = devices.filter((d) => !d.isNew && d.from !== undefined && d.from !== d.target)
  const adds = devices.filter((d) => d.isNew)
  const moverIds = new Set(movers.map((d) => d.id))

  /* ---------- 依赖边：目标地址当前被改址设备占用 ---------- */
  const deps = new Map<string, Set<string>>() // device -> 必须先迁出的设备
  for (const d of movers) {
    const set = new Set<string>()
    const occ = occupants.get(d.target)
    if (occ) {
      for (const id of occ) {
        if (id === d.id) continue
        if (moverIds.has(id)) set.add(id)
      }
    }
    deps.set(d.id, set)
  }

  /* ---------- 阻断项 1：目标地址被不会迁走的既有设备占住 ---------- */
  for (const d of devices) {
    if (d.isNew || (d.from !== undefined && d.from !== d.target)) {
      // 需要目标地址腾空的设备（新增 / 改址）
    } else {
      continue
    }
    const occ = occupants.get(d.target)
    if (!occ) continue
    for (const id of occ) {
      if (id === d.id) continue
      if (moverIds.has(id)) continue // 该占用者会迁走，形成依赖边
      const holder = existingById.get(id)?.name ?? '未命名设备'
      blockers.push({
        kind: 'occupied',
        devices: [holder],
        address: d.target,
        message: `设备“${d.name}”的目标地址 ${intToIp(d.target)} 被不会迁走的既有设备“${holder}”占用：请先在主机地址分配中为其改址或删除，再执行迁移。`,
      })
    }
  }

  /* ---------- 强连通分量（Tarjan，迭代式，仅改址设备参与） ---------- */
  const cycles = findCycles(movers, deps)

  /* ---------- 识别环并按「环内最小旧地址升序」确定逐环处理顺序 ---------- */
  const moverById = new Map(movers.map((d) => [d.id, d]))
  const cycleOrder = cycles
    .map((memberIds) => {
      const views = memberIds.map((id) => moverById.get(id)!)
      const minFrom = Math.min(...views.map((d) => d.from!))
      return { memberIds, views, minFrom }
    })
    .sort((a, b) => a.minFrom - b.minFrom)

  const cycleViews: MigrationCycle[] = []
  function staticBlockedReturn(reason: string): MigrationPlan {
    for (const { memberIds, views } of cycleOrder) {
      cycleViews.push({
        deviceIds: memberIds,
        deviceNames: views.map((d) => d.name),
        blocked: true,
        blockReason: reason,
      })
    }
    return {
      ok: false,
      steps: [],
      blockers,
      cycles: cycleViews,
      counts: { moves: movers.length, adds: adds.length, cycles: cycles.length, tempMoves: 0 },
      changedDevices: movers.length + adds.length,
    }
  }

  // 存在静态阻断项（目标被不迁走的设备占住等）：不输出任何步骤（冲突预览式语义）
  if (blockers.length > 0) {
    return staticBlockedReturn('存在其他阻断项（见上方说明），本环未安排临时锚点')
  }

  /* ---------- 模拟执行，逐步维护占用，保证每一步都不会产生瞬时重复 IPv4 ----------
   * 关键：各环【逐环】完成「锚点临时迁出 → 环内改址 → 锚点归位」后才开始下一环；
   * 临时地址在选址当时按「实况占用 ∪ 全部最终目标」选取，环一结束即释放，
   * 因此后续独立环可以复用该临时地址（不做跨环永久预留）。 */
  const steps: MigrationStep[] = []
  const occupied = new Map<number, Set<string>>(
    [...occupants.entries()].map(([addr, set]) => [addr, new Set(set)]),
  )
  const pending = new Map<string, DeviceView>()
  for (const d of movers) pending.set(d.id, d)

  function removeOccupant(addr: number, id: string) {
    const set = occupied.get(addr)
    if (set) set.delete(id)
  }
  function addOccupant(addr: number, id: string) {
    let set = occupied.get(addr)
    if (!set) {
      set = new Set()
      occupied.set(addr, set)
    }
    set.add(id)
  }
  /** 目标地址当前已无「尚未完成迁移」的占用者（不含自身） */
  function targetFree(d: DeviceView): boolean {
    const set = occupied.get(d.target)
    if (!set) return true
    for (const id of set) if (id !== d.id) return false
    return true
  }
  /** 步骤原因中列出设备 X 所依赖（需先迁出）的设备名 */
  function depNamesOf(d: DeviceView): string[] {
    return [...(deps.get(d.id) ?? [])]
      .map((id) => existingById.get(id)?.name ?? '未命名设备')
      .sort()
  }
  const byTargetThenId = (a: DeviceView, b: DeviceView) =>
    a.target - b.target || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

  /**
   * 选址当时为某一环挑选锚点与临时地址：
   * 锚点候选为环中原网段可用的设备（按原地址升序、ID 次序）；
   * 临时地址在该原网段内取最低可用主机地址，仅排除
   *   ① 选址当时该网段内的实况占用（此前各环已结束、其临时地址已释放，故可被复用）
   *   ② 全部最终目标地址（临时地址绝不能与任何设备的终态撞址）。
   */
  function chooseTempForCycle(
    views: DeviceView[],
  ): { device: DeviceView; temp: number; tempSeg: AllocSegment } | { triedReasons: string[] } {
    const candidates = views
      .filter((d) => d.fromSegment)
      .sort((a, b) => (a.from! - b.from! || a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const triedReasons: string[] = []
    for (const device of candidates) {
      const seg = device.fromSegment!
      const forbidden = new Set<number>(allTargets)
      // 选址当时该网段内仍有设备在线的地址才排除（已迁出留下的空集合不算占用，
      // 这样前序环已释放的临时地址才能被后续环复用）
      for (const [addr, set] of occupied) {
        if (set.size > 0 && addr > seg.start && addr < seg.end) forbidden.add(addr)
      }
      let found: number | null = null
      for (let addr = seg.start + 1; addr < seg.end; addr++) {
        if (!forbidden.has(addr)) {
          found = addr >>> 0
          break
        }
      }
      if (found !== null) return { device, temp: found, tempSeg: seg }
      triedReasons.push(
        `设备“${device.name}”的原网段 ${seg.cidr}（可用 ${seg.firstUsable} ~ ${seg.lastUsable}）内没有可排除选址当时占用与全部目标地址后的空闲地址`,
      )
    }
    return { triedReasons }
  }

  function markCycleBlocked(memberIds: string[], views: DeviceView[], detail: string) {
    const names = views.map((d) => d.name)
    blockers.push({
      kind: 'no-temp',
      devices: names,
      message:
        `地址依赖环（${names.map((n) => `“${n}”`).join(' → ')} 形成闭环）无法打破：${detail}。` +
        `已阻止该环并阻止整份清单，请先释放原网段内的一个可用主机地址（或调整 CSV 目标地址）后重试。`,
    })
    cycleViews.push({
      deviceIds: memberIds,
      deviceNames: names,
      blocked: true,
      blockReason: detail,
    })
  }

  /** 整份清单阻断时，把尚未登记的剩余环统一标记为「未执行」，不输出任何部分步骤 */
  function markRemainingBlocked(fromIdx: number, detail: string) {
    for (let cj = fromIdx; cj < cycleOrder.length; cj++) {
      const later = cycleOrder[cj]
      if (cycleViews.some((c) => c.deviceIds === later.memberIds)) continue
      cycleViews.push({
        deviceIds: later.memberIds,
        deviceNames: later.views.map((d) => d.name),
        blocked: true,
        blockReason: detail,
      })
    }
  }

  let order = 1
  let aborted = false

  // 第 1 阶段：逐环解开（按环内最小旧地址升序）。每环完整结束后再处理下一环。
  for (let ci = 0; ci < cycleOrder.length; ci++) {
    const { memberIds, views } = cycleOrder[ci]
    const names = views.map((d) => d.name)
    const memberSet = new Set(memberIds)
    const cycleLabel = names.map((n) => `“${n}”`).join(' → ')

    // ① 选址当时挑锚点 + 临时地址（不跨环预留：前序环的临时地址此时已释放）
    const chosen = chooseTempForCycle(views)
    if ('triedReasons' in chosen) {
      const noValidSeg = views.filter((d) => !d.fromSegment)
      const detail =
        chosen.triedReasons.length === 0
          ? `环中设备都无法在其原网段内安排临时地址：${noValidSeg
              .map((d) => `“${d.name}”（${d.fromInvalidReason ?? '原网段不可用'}）`)
              .join('；')}`
          : chosen.triedReasons.join('；')
      markCycleBlocked(memberIds, views, detail)
      // 其后各环同样不再尝试：整份清单阻断，不输出任何部分步骤
      markRemainingBlocked(ci + 1, '前序环路已阻断，本环未执行')
      aborted = true
      break
    }

    const pivot = chosen.device
    const { temp, tempSeg } = chosen

    // ② 锚点临时迁出（在实况占用表中腾空其原地址、占住临时地址）
    removeOccupant(pivot.from!, pivot.id)
    addOccupant(temp, pivot.id)
    steps.push({
      order: order++,
      kind: 'temp-move',
      deviceId: pivot.id,
      name: pivot.name,
      fromAddress: pivot.from,
      address: temp,
      tempAddress: temp,
      targetCidr: pivot.targetCidr,
      tempCidr: tempSeg.cidr,
      reason: `设备“${pivot.name}”处于地址依赖环（${cycleLabel}）中，先迁到原网段 ${tempSeg.cidr} 内选址当时最低的临时可用地址 ${intToIp(temp)}（已避开当时占用与全部最终目标），为环路腾空 ${intToIp(pivot.from!)}；本环完成后该临时地址即释放，可供后续环路复用`,
    })

    // ③ 环内改址：只在本环成员中取目标已腾空、目标地址最低者，直到锚点归位。
    //    极端情况下（如异常重复登记导致环外设备卡住环目标），先把环外已就绪的设备迁走；
    //    正常数据下环成员自锚点腾空起即链式可执行，步骤在本环内连续完成。
    while (pending.has(pivot.id)) {
      const readyMembers = [...pending.values()]
        .filter((d) => memberSet.has(d.id) && targetFree(d))
        .sort(byTargetThenId)
      if (readyMembers.length > 0) {
        const d = readyMembers[0]
        if (d.id === pivot.id) {
          // 锚点归位：临时地址 → 目标地址，临时地址同步释放，本环完成
          removeOccupant(temp, d.id)
          addOccupant(d.target, d.id)
          pending.delete(d.id)
          steps.push({
            order: order++,
            kind: 'cycle-complete',
            deviceId: d.id,
            name: d.name,
            fromAddress: temp,
            address: d.target,
            tempAddress: temp,
            targetCidr: d.targetCidr,
            reason: `环路已腾空：设备“${d.name}”从临时地址 ${intToIp(temp)} 迁到目标地址 ${intToIp(d.target)}（${d.targetCidr}），临时地址 ${intToIp(temp)} 同步释放、可被后续环路复用，环路完成`,
          })
          break
        }
        removeOccupant(d.from!, d.id)
        addOccupant(d.target, d.id)
        pending.delete(d.id)
        const depNames = depNamesOf(d)
        steps.push({
          order: order++,
          kind: 'move',
          deviceId: d.id,
          name: d.name,
          fromAddress: d.from,
          address: d.target,
          targetCidr: d.targetCidr,
          reason:
            depNames.length > 0
              ? `环内改址：目标地址 ${intToIp(d.target)} 的原占用设备 ${depNames.map((n) => `“${n}”`).join('、')} 已迁出，现可改址（${intToIp(d.from!)} → ${intToIp(d.target)}）`
              : `环内改址：目标地址 ${intToIp(d.target)} 已腾空（${intToIp(d.from!)} → ${intToIp(d.target)}），不产生瞬时重复`,
        })
        continue
      }

      // 环成员均未就绪：若环外已有可直接迁移的设备（其迁出会释放环目标），先迁它
      const readyOutside = [...pending.values()]
        .filter((d) => !memberSet.has(d.id) && targetFree(d))
        .sort(byTargetThenId)
      if (readyOutside.length > 0) {
        const d = readyOutside[0]
        removeOccupant(d.from!, d.id)
        addOccupant(d.target, d.id)
        pending.delete(d.id)
        const depNames = depNamesOf(d)
        steps.push({
          order: order++,
          kind: 'move',
          deviceId: d.id,
          name: d.name,
          fromAddress: d.from,
          address: d.target,
          targetCidr: d.targetCidr,
          reason:
            depNames.length > 0
              ? `目标地址 ${intToIp(d.target)} 的原占用设备 ${depNames.map((n) => `“${n}”`).join('、')} 已迁出，现可改址（${intToIp(d.from!)} → ${intToIp(d.target)}）`
              : `目标地址 ${intToIp(d.target)} 当前空闲，可直接改址（${intToIp(d.from!)} → ${intToIp(d.target)}），不产生瞬时重复`,
        })
        continue
      }

      // 理论上不可达：每个环都已通过临时锚点打破；防御性阻断
      blockers.push({
        kind: 'no-temp',
        devices: [...pending.values()].map((d) => d.name),
        message: '仍存在无法排序的地址依赖环，迁移编排已中止。',
      })
      aborted = true
      break
    }

    if (aborted) {
      // 登记尚未写入视图的剩余环
      markRemainingBlocked(ci + 1, '编排已中止，本环未执行')
      break
    }

    cycleViews.push({
      deviceIds: memberIds,
      deviceNames: names,
      pivotId: pivot.id,
      pivotName: pivot.name,
      tempAddress: temp,
      tempCidr: tempSeg.cidr,
      blocked: false,
    })
  }

  // 第 2 阶段：全部环结束后，剩余无环（DAG）改址设备反复取「目标已腾空、目标最低」者执行。
  // 前序环迁出 / 环外先行步骤已腾空的地址此时均可直接使用。
  if (!aborted) {
    while (pending.size > 0) {
      const ready = [...pending.values()].filter(targetFree).sort(byTargetThenId)
      if (ready.length === 0) {
        blockers.push({
          kind: 'no-temp',
          devices: [...pending.values()].map((d) => d.name),
          message: '仍存在无法排序的地址依赖，迁移编排已中止。',
        })
        aborted = true
        break
      }
      const d = ready[0]
      removeOccupant(d.from!, d.id)
      addOccupant(d.target, d.id)
      pending.delete(d.id)
      const depNames = depNamesOf(d)
      steps.push({
        order: order++,
        kind: 'move',
        deviceId: d.id,
        name: d.name,
        fromAddress: d.from,
        address: d.target,
        targetCidr: d.targetCidr,
        reason:
          depNames.length > 0
            ? `目标地址 ${intToIp(d.target)} 的原占用设备 ${depNames.map((n) => `“${n}”`).join('、')} 已迁出，现可改址（${intToIp(d.from!)} → ${intToIp(d.target)}）`
            : `目标地址 ${intToIp(d.target)} 当前空闲，可直接改址（${intToIp(d.from!)} → ${intToIp(d.target)}），不产生瞬时重复`,
      })
    }
  }

  // 第 3 阶段：新建设备上线（目标地址此时必然已腾空，否则前面已作为阻断项拦截）
  if (!aborted) {
    for (const d of adds.sort(byTargetThenId)) {
      addOccupant(d.target, d.id)
      steps.push({
        order: order++,
        kind: 'add',
        deviceId: d.id,
        name: d.name,
        address: d.target,
        targetCidr: d.targetCidr,
        reason: `新设备“${d.name}”上线到目标地址 ${intToIp(d.target)}（${d.targetCidr}）；该地址已腾空，不会与任何在线设备重复`,
      })
    }
  }

  const tempMoves = steps.filter((s) => s.kind === 'temp-move').length

  if (aborted || blockers.length > 0) {
    return {
      ok: false,
      steps: [],
      blockers,
      cycles: cycleViews,
      counts: { moves: movers.length, adds: adds.length, cycles: cycles.length, tempMoves: 0 },
      changedDevices: movers.length + adds.length,
    }
  }

  return {
    ok: true,
    steps,
    blockers: [],
    cycles: cycleViews,
    counts: {
      moves: movers.length,
      adds: adds.length,
      cycles: cycles.length,
      tempMoves,
    },
    changedDevices: movers.length + adds.length,
  }
}

/* ---------- Tarjan 强连通分量（迭代实现，避免大环路递归溢出） ---------- */

function findCycles(movers: DeviceView[], deps: Map<string, Set<string>>): string[][] {
  const indexOf = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let counter = 0
  const result: string[][] = []

  for (const start of movers) {
    if (indexOf.has(start.id)) continue
    // 迭代 DFS 帧：[节点, 下一条出边下标]
    const frames: Array<[string, number]> = [[start.id, 0]]
    indexOf.set(start.id, counter)
    low.set(start.id, counter)
    counter++
    stack.push(start.id)
    onStack.add(start.id)

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      const [v, nextIdx] = frame
      const neighbors = [...(deps.get(v) ?? [])]
      if (nextIdx < neighbors.length) {
        frame[1] = nextIdx + 1
        const w = neighbors[nextIdx]
        if (!indexOf.has(w)) {
          indexOf.set(w, counter)
          low.set(w, counter)
          counter++
          stack.push(w)
          onStack.add(w)
          frames.push([w, 0])
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, indexOf.get(w)!))
        }
      } else {
        frames.pop()
        if (low.get(v) === indexOf.get(v)) {
          const component: string[] = []
          while (true) {
            const w = stack.pop()!
            onStack.delete(w)
            component.push(w)
            if (w === v) break
          }
          // 仅保留真正的环：分量内多于一台设备；自环（目标=原址）已在 movers 阶段排除
          if (component.length > 1) result.push(component)
        }
        if (frames.length > 0) {
          const parent = frames[frames.length - 1][0]
          low.set(parent, Math.min(low.get(parent)!, low.get(v)!))
        }
      }
    }
  }
  return result
}

/* ---------- 复制用纯文本清单 ---------- */

/** 生成适合复制粘贴的制表符分隔清单（每行：步骤、操作、设备、原地址、目标地址、临时地址、网段、原因） */
export function migrationPlanText(plan: MigrationPlan): string {
  if (!plan.ok || plan.steps.length === 0) return ''
  const header = ['步骤', '操作', '设备', '原地址', '目标地址', '临时地址', '目标网段', '原因'].join('\t')
  const lines = plan.steps.map((s) =>
    [
      String(s.order),
      MIGRATION_STEP_LABEL[s.kind],
      s.name,
      s.fromAddress !== undefined ? intToIp(s.fromAddress) : '—',
      intToIp(s.address),
      s.tempAddress !== undefined ? intToIp(s.tempAddress) : '—',
      s.targetCidr,
      s.reason,
    ].join('\t'),
  )
  lines.push(
    `\t完成\t—\t—\t—\t—\t—\t共 ${plan.steps.length} 步，按序执行期间任一地址都不会同时被两台设备占用（无瞬时重复 IPv4）`,
  )
  return [header, ...lines].join('\n')
}
