// IPv4 路径分片预演（纯本地计算，模拟 RFC 791 的逐跳分片行为）。
//
// 固定前提：
//   1. IPv4 首部固定 20 字节（IHL=5，无选项），无任何扩展；
//   2. 发送设备给出一个原始报文：总长度 = 20 + 负载字节数（负载最大 65515，
//      即 2^16-1 - 20，不超过 IPv4 总长度字段 65535 的上限）；
//   3. 每一跳处理「上一跳输出的全部分片」：
//        a. 分片总长度 <= 本跳 MTU：原样通过，偏移量 / MF 完全不变；
//        b. 总长度 > MTU 且 DF=1：在本跳阻断，报告首个阻断跳并停止（DF 只存在于
//           尚未分片的原始报文上；一旦已经分片，后续跳只能继续分片，不能重组）；
//        c. 总长度 > MTU 且 DF=0：在本跳对该片再分片，取不超过 MTU 的最大负载，
//           除原始报文最后一片外，每个子片负载必须是 8 的倍数（IPv4 片偏移以
//           8 字节为单位所要求）；
//   4. 片偏移始终相对「原始负载」起点、以 8 字节计；MF=1 表示该片之后仍有原始数据，
//      即该片的负载末端（offset*8 + payloadLen）尚未到达原始负载末尾；
//   5. 路由器只可能再次分片，绝不重组——因此跳数推进时片数只增不减。
//
// 本模块不接触真实网络、不做任何发送动作，只把逐跳结果结构化返回给面板渲染。

import type { HostAssignment, PlanResult } from './types'
import { intToIp } from './ip'
import { reconcileHosts } from './hosts'

/** 固定 IPv4 首部长度（无选项） */
export const IPV4_HEADER_LEN = 20
/** 负载最小 / 最大字节数（总长度上限 65535） */
export const MIN_PAYLOAD = 1
export const MAX_PAYLOAD = 65515
/** 路径跳数与单跳 MTU 的允许范围（68 = RFC 791 规定的最小 IPv4 MTU） */
export const MIN_HOPS = 1
export const MAX_HOPS = 8
export const MIN_MTU = 68
export const MAX_MTU = 65535

/** 面板上一行跳的录入（行内稳定 ID，跳数增删后按它原样保留） */
export interface FragHopInput {
  id: string
  /** MTU 文本输入（始终保留用户原文，非法时不静默改写） */
  mtu: string
}

export type FragErrorField = 'device' | 'payload' | 'mtu'

export interface FragValidationError {
  field: FragErrorField
  /** field=mtu 时定位到第几跳（1 起），其余为 undefined */
  hopIndex?: number
  message: string
}

/** 一个分片（任何一跳的输入 / 输出单位都相同） */
export interface FragPiece {
  /** 本片负载相对原始负载起点的字节偏移（0 起） */
  payloadStart: number
  /** 本片负载结束偏移（不含），负载长度 = end - start */
  payloadEnd: number
  /** 负载字节数 */
  payloadLen: number
  /** 总长度 = 20 + 负载长度 */
  totalLen: number
  /** IPv4 片偏移字段值（payloadStart / 8，恒为整数） */
  offset: number
  /** 本片之后是否仍有原始数据（RFC 791 MF） */
  mf: boolean
}

/** 单个分片在某一跳的处置结果 */
export interface FragHopPiece {
  piece: FragPiece
  /** 原样通过：总长度未超过本跳 MTU */
  passed: boolean
  /** 在本跳被拆成若干子片（passed=false 且未阻断时有值，子片按偏移升序） */
  splitInto?: FragPiece[]
}

export interface FragHopOutcome {
  /** 第几跳（1 起） */
  hopIndex: number
  mtu: number
  pieces: FragHopPiece[]
  /** DF=1 原始报文在本跳无法通过时的阻断说明；非空表示后续跳不再执行 */
  blocked?: {
    /** 触发阻断的原始分片描述（首个超 MTU 的片） */
    piece: FragPiece
    message: string
  }
  /** 进入本跳的片数（= 上一跳输出片数） */
  inCount: number
  /** 本跳输出片数（阻断时为进入本跳的片数） */
  outCount: number
}

export interface FragResult {
  payloadLen: number
  df: boolean
  hops: FragHopOutcome[]
  /** 最终离开最后一跳（或在阻断跳之前）的全部分片 */
  finalPieces: FragPiece[]
  blocked: boolean
  /** 阻断跳序号（1 起；未阻断为 undefined） */
  blockedHopIndex?: number
  /** 最终片数 */
  pieceCount: number
  /** 最终首部开销 = 片数 × 20 字节 */
  headerOverhead: number
  /** 最终全部分片总长度之和 = 原始负载 + 首部开销 */
  totalBytes: number
}

/** 当前有效主机登记（供设备下拉选择）：随规划 / 登记变化实时重算，失效项不列出 */
export interface FragDevice {
  id: string
  name: string
  ip: string
  segmentCidr: string
  segmentName: string
}

/** 从当前规划与登记中导出有效设备清单（按 IPv4 升序，与 dnsmasq 租约展示顺序一致） */
export function listValidDevices(
  assignments: HostAssignment[],
  result: PlanResult,
): FragDevice[] {
  if (result.inputErrors.length > 0) return []
  const { rows } = reconcileHosts(assignments, result)
  return rows
    .filter((r) => r.valid && r.segment)
    .map((r) => ({
      id: r.assignment.id,
      name: r.assignment.name || '未命名设备',
      ip: intToIp(r.assignment.address),
      segmentCidr: r.segment!.cidr,
      segmentName: r.segment!.name,
    }))
    .sort((a, b) => (a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0))
}

/** 解析负载字节文本：空串 / 非整数 / 越界都视为非法（不做夹取，保留用户输入） */
export function parsePayload(raw: string): { value: number } | { error: string } {
  const text = raw.trim()
  if (text === '') return { error: '请输入负载字节数' }
  if (!/^\d+$/.test(text)) return { error: `“${text}”不是整数，负载字节数须为 ${MIN_PAYLOAD}～${MAX_PAYLOAD} 的整数` }
  const value = Number(text)
  if (value < MIN_PAYLOAD || value > MAX_PAYLOAD) {
    return { error: `负载字节数须在 ${MIN_PAYLOAD}～${MAX_PAYLOAD} 之间（IPv4 总长度上限 65535，含 20 字节首部）` }
  }
  return { value }
}

/** 解析单跳 MTU 文本 */
export function parseMtu(raw: string): { value: number } | { error: string } {
  const text = raw.trim()
  if (text === '') return { error: '请输入该跳 MTU' }
  if (!/^\d+$/.test(text)) return { error: `“${text}”不是整数，MTU 须为 ${MIN_MTU}～${MAX_MTU} 的整数` }
  const value = Number(text)
  if (value < MIN_MTU || value > MAX_MTU) {
    return { error: `MTU 须在 ${MIN_MTU}～${MAX_MTU} 之间（${MIN_MTU} 为 RFC 791 规定的最小 IPv4 MTU）` }
  }
  return { value }
}

/**
 * 校验整个预演输入，按「设备 → 负载 → 逐跳 MTU（跳序）」给出可定位错误。
 * 任一错误存在即暂停预演；devices 为当前有效设备清单（空清单本身不算字段错误，
 * 由面板单独给出「暂无有效设备」提示）。
 */
export function validateFragInput(input: {
  deviceId: string
  devices: FragDevice[]
  payloadRaw: string
  hops: FragHopInput[]
}): { errors: FragValidationError[]; payloadLen?: number; mtus?: number[] } {
  const errors: FragValidationError[] = []
  let payloadLen: number | undefined
  const mtus: number[] = []

  if (input.devices.length > 0 && input.deviceId === '') {
    errors.push({ field: 'device', message: '请选择发送设备' })
  }

  const payload = parsePayload(input.payloadRaw)
  if ('error' in payload) {
    errors.push({ field: 'payload', message: payload.error })
  } else {
    payloadLen = payload.value
  }

  if (input.hops.length < MIN_HOPS) {
    errors.push({ field: 'mtu', message: `路径至少需要 ${MIN_HOPS} 跳` })
  }
  if (input.hops.length > MAX_HOPS) {
    errors.push({ field: 'mtu', message: `路径最多 ${MAX_HOPS} 跳，请删除多余的跳` })
  }
  input.hops.slice(0, MAX_HOPS).forEach((hop, i) => {
    const parsed = parseMtu(hop.mtu)
    if ('error' in parsed) {
      errors.push({ field: 'mtu', hopIndex: i + 1, message: parsed.error })
    } else {
      mtus[i] = parsed.value
    }
  })

  return { errors, payloadLen, mtus: errors.some((e) => e.field === 'mtu') ? undefined : mtus }
}

/** 构造发送设备处的原始报文（单一分片，offset=0，MF=0） */
export function originalDatagram(payloadLen: number): FragPiece[] {
  return [
    {
      payloadStart: 0,
      payloadEnd: payloadLen,
      payloadLen,
      totalLen: IPV4_HEADER_LEN + payloadLen,
      offset: 0,
      mf: false,
    },
  ]
}

/**
 * 按本跳 MTU 拆分一个超 MTU 的分片（调用方已确认需要拆分：totalLen > mtu、DF=0）。
 * 规则：取不超过 mtu 的最大负载（mtu - 20），非原始最后一片的子片负载向下取整到 8；
 * 子片偏移恒为 8 的倍数；最后一个覆盖到原始负载末尾的子片 MF=0，其余 MF=1。
 */
export function fragmentPiece(piece: FragPiece, mtu: number, originalPayloadLen: number): FragPiece[] {
  const maxPayload = mtu - IPV4_HEADER_LEN
  const out: FragPiece[] = []
  let cursor = piece.payloadStart
  while (cursor < piece.payloadEnd) {
    let take = Math.min(maxPayload, piece.payloadEnd - cursor)
    // 除「覆盖原始负载末尾的子片」外，负载必须是 8 的倍数（进入这里时 cursor 恒 8 对齐）
    const reachesOriginalEnd = cursor + take >= originalPayloadLen
    if (!reachesOriginalEnd) {
      take = take - (take % 8)
    }
    const start = cursor
    const end = cursor + take
    out.push({
      payloadStart: start,
      payloadEnd: end,
      payloadLen: take,
      totalLen: IPV4_HEADER_LEN + take,
      offset: start / 8,
      mf: end < originalPayloadLen,
    })
    cursor = end
  }
  return out
}

/**
 * 逐跳预演：从发送设备的原始报文开始，每跳处理上一跳输出的全部分片。
 * 调用方须先用 validateFragInput 确认输入合法。
 */
export function simulateFragments(input: {
  payloadLen: number
  df: boolean
  mtus: number[]
}): FragResult {
  const { payloadLen, df, mtus } = input
  const hops: FragHopOutcome[] = []
  let current: FragPiece[] = originalDatagram(payloadLen)
  let blocked = false
  let blockedHopIndex: number | undefined

  for (let h = 0; h < mtus.length; h++) {
    const mtu = mtus[h]
    const pieceResults: FragHopPiece[] = []
    const next: FragPiece[] = []
    let block: NonNullable<FragHopOutcome['blocked']> | undefined

    for (const piece of current) {
      if (piece.totalLen <= mtu) {
        // 原样通过：偏移 / MF 一律不变
        pieceResults.push({ piece, passed: true })
        next.push(piece)
        continue
      }
      if (df) {
        // DF=1 时此前各跳必然都是原样通过（否则早在首个超 MTU 跳阻断），
        // 故到达此处的一定是尚未分片的原始报文：阻断并立即停止
        block = {
          piece,
          message: `第 ${h + 1} 跳 MTU=${mtu} 小于报文总长度 ${piece.totalLen}（负载 ${payloadLen} + 首部 20），DF=1 禁止分片，报文在此被丢弃`,
        }
        pieceResults.push({ piece, passed: false })
        break
      }
      const children = fragmentPiece(piece, mtu, payloadLen)
      pieceResults.push({ piece, passed: false, splitInto: children })
      next.push(...children)
    }

    if (block) {
      blocked = true
      blockedHopIndex = h + 1
      hops.push({
        hopIndex: h + 1,
        mtu,
        pieces: pieceResults,
        blocked: block,
        inCount: current.length,
        outCount: current.length,
      })
      break
    }
    hops.push({
      hopIndex: h + 1,
      mtu,
      pieces: pieceResults,
      inCount: current.length,
      outCount: next.length,
    })
    current = next
  }

  return {
    payloadLen,
    df,
    hops,
    finalPieces: current,
    blocked,
    blockedHopIndex,
    pieceCount: current.length,
    headerOverhead: current.length * IPV4_HEADER_LEN,
    totalBytes: current.reduce((sum, p) => sum + p.totalLen, 0),
  }
}
