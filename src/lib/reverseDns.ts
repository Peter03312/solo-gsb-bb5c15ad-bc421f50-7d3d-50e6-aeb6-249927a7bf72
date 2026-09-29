// 反向 DNS 区域文件生成（in-addr.arpa / RFC 2317）。
// 本模块只读取当前规划结果与主机登记，绝不修改规划、基线、路由汇总、主机登记与导出。
//
// 生成规则：
//   - 数据来源：所选网段中经当前规划校验「有效」（地址仍在所属网段可用范围内、未重复）
//     且设备名为「合法绝对域名（FQDN）」的主机登记；单标签设备名（如「网关」「core-sw」）
//     视为并非域名，静默跳过、不报错；
//   - /24：生成标准 classful 反向区域 <前 3 字节反序>.in-addr.arpa 的 PTR 记录
//     （<末位> IN PTR <域名>.），按 IP 升序；
//   - /25～/30：按 RFC 2317 生成两段文本——
//       父区域（所属 /24 的 in-addr.arpa）：每条登记一行
//         <末位> IN CNAME <末位>.<子区域>.
//       子区域（独立 zone 文件）：每条登记一行 <末位> IN PTR <域名>.
//     子区域以网段「起始末位-结束末位」命名，如 192.168.10.16/30 -> 16-19.10.168.192.in-addr.arpa；
//   - 重复域名（归一：去尾点、转小写）或不合法名称：逐条收集错误并「停止整体生成」
//     （不输出任何区域文本）；无效登记（越界/网络/广播/重复地址/孤儿）不参与、不阻断。
//
// 区域文件中的 SOA/NS 仅为占位模板（ns.example.com. / hostmaster.example.com.），
// 序列号默认取生成当日 UTC 的 YYYYMMDD00，部署前需按实际权威 DNS 替换。

import { intToIp } from './ip'
import { allocatableSegments, reconcileHosts, type AllocSegment } from './hosts'
import type { HostAssignment, PlanResult } from './types'

/** 占位的权威名称服务器与管理员邮箱（部署前替换） */
export const PLACEHOLDER_NS = 'ns.example.com.'
export const PLACEHOLDER_RNAME = 'hostmaster.example.com.'
/** 区域默认 TTL（秒） */
export const ZONE_DEFAULT_TTL = 86400

/** RFC 2317 支持的网段前缀范围 */
export const RFC2317_MIN_PREFIX = 25
export const RFC2317_MAX_PREFIX = 30

export interface ReverseDnsOptions {
  /** SOA 序列号（YYYYMMDDnn）；缺省取生成当日 UTC 的 YYYYMMDD00 */
  serial?: string
}

/** 单标签设备名（并非域名）：静默跳过、不进入输出、不报错 */
export interface ReverseDnsSkippedRow {
  assignment: HostAssignment
  ip: string
}

/** 该网段内在当前规划下失效的登记（越界 / 网络地址 / 广播地址 / 重复地址等）：不读取、不阻断 */
export interface ReverseDnsExcludedRow {
  assignment: HostAssignment
  ip: string
  /** 失效原因（中文） */
  reason: string
}

/** 进入 PTR 输出的一条有效登记（已按 IP 升序） */
export interface ReverseDnsEntry {
  assignment: HostAssignment
  ip: string
  /** 登记设备名原文（已 trim） */
  rawName: string
  /** 归一绝对域名（小写、带根尾点），用于 PTR RDATA */
  fqdn: string
  address: number
  /** 反向记录 owner 的末位标签（IPv4 最后一个字节） */
  lastOctet: number
}

export interface ReverseDnsError {
  /** 登记在该网段全部相关行中的序号（从 1 开始），用于明确定位 */
  index: number
  assignment: HostAssignment
  ip: string
  name: string
  message: string
}

export type ReverseDnsMode = 'classful' | 'rfc2317'

export interface ReverseDnsResult {
  /** 是否可生成（/24 或 /25～/30）；不支持时为 false */
  supported: boolean
  /** 不支持原因（supported=false 时给出） */
  unsupportedReason?: string
  mode: ReverseDnsMode
  segment: AllocSegment
  /** 父 /24 反向区域名，如 10.168.192.in-addr.arpa */
  parentZone: string
  /** RFC 2317 子区域名（仅 mode=rfc2317），如 16-19.10.168.192.in-addr.arpa */
  childZone?: string
  skipped: ReverseDnsSkippedRow[]
  /** 该网段内在当前规划下失效、未被读取的登记（仅提示，不参与生成） */
  excluded: ReverseDnsExcludedRow[]
  entries: ReverseDnsEntry[]
  errors: ReverseDnsError[]
  /** 实际使用的 SOA 序列号 */
  serial: string
  /** /24：完整区域文件文本；有错 / 无记录时为空串 */
  zoneText: string
  /** RFC 2317 父区域片段（CNAME）；有错 / 无记录时为空串 */
  parentText?: string
  /** RFC 2317 子区域文件文本（PTR）；有错 / 无记录时为空串 */
  childText?: string
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i
// 合法绝对域名的总长度（不含根尾点）上限
const MAX_FQDN_LENGTH = 253

/**
 * 判定设备名是否意在作为绝对域名，并做合法性校验。
 * 返回 { kind: 'fqdn', fqdn } 表示合法绝对域名（fqdn 为归一的小写带尾点形式）；
 * 返回 { kind: 'skip' } 表示单标签名称（并非域名，静默跳过）；
 * 返回 { kind: 'error', message } 表示意在多标签域名但名称不合法（阻断生成）。
 */
export function classifyDeviceName(raw: string):
  | { kind: 'fqdn'; fqdn: string }
  | { kind: 'skip' }
  | { kind: 'error'; message: string } {
  const name = raw.trim()
  if (!name) return { kind: 'skip' }
  // 无点：单标签主机名/设备名，并非绝对域名
  if (!name.includes('.')) return { kind: 'skip' }
  // 根尾点：绝对域名允许恰好一个尾点；两个及以上（空标签）非法
  let body = name
  if (body.endsWith('.')) {
    body = body.slice(0, -1)
    if (body.endsWith('.')) {
      return { kind: 'error', message: '绝对域名的根尾点只能有一个（末尾出现多余的点）' }
    }
  }
  if (body.length > MAX_FQDN_LENGTH) {
    return { kind: 'error', message: `域名长度 ${body.length} 超过 ${MAX_FQDN_LENGTH} 个字符（不含根尾点）` }
  }
  // 非 ASCII（含中文等）标签不属于合法 LDH 主机域名（未做 IDNA 编码）
  if (/[^\x20-\x7E]/.test(body)) {
    return { kind: 'error', message: '域名包含非 ASCII 字符（国际域名需先做 IDNA/Punycode 编码）' }
  }
  if (body.includes(' ')) return { kind: 'error', message: '域名中不能包含空格' }
  if (body.includes('..')) return { kind: 'error', message: '域名中不允许出现连续点（空标签）' }
  const labels = body.split('.')
  if (labels.length < 2) return { kind: 'skip' }
  for (const label of labels) {
    if (label.length === 0) return { kind: 'error', message: '域名中不允许出现空标签（连续点）' }
    if (label.length > 63) {
      return { kind: 'error', message: `标签“${label.slice(0, 20)}…”长度 ${label.length} 超过 63 个字符` }
    }
    if (!LABEL_RE.test(label)) {
      return {
        kind: 'error',
        message:
          `标签“${label}”不合法：每段只能由字母、数字和连字符（-）组成，` +
          '且必须以字母或数字开头和结尾、长度 1–63（不接受下划线等字符）',
      }
    }
  }
  const tld = labels[labels.length - 1]
  if (/^[0-9]+$/.test(tld)) {
    return { kind: 'error', message: `顶级标签“${tld}”不能是纯数字（缺少合法顶级域）` }
  }
  return { kind: 'fqdn', fqdn: `${body.toLowerCase()}.` }
}

/** 在当前规划中解析网段（必须是成功分配的固定 / 自动网段）；失效返回 null */
export function resolveReverseSegment(result: PlanResult, ownerId: string): AllocSegment | null {
  if (!ownerId) return null
  return allocatableSegments(result).find((s) => s.ownerId === ownerId) ?? null
}

/** /24 父反向区域名：取网络地址前 3 个字节反序，如 192.168.10.16 -> 10.168.192.in-addr.arpa */
export function parentZoneName(network: number): string {
  const octets = [
    (network >>> 24) & 255,
    (network >>> 16) & 255,
    (network >>> 8) & 255,
    network & 255,
  ]
  return `${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa`
}

/** RFC 2317 子区域名：<起始末位>-<结束末位>.<父区域> */
export function childZoneName(segment: AllocSegment): string {
  const startLast = segment.start & 255
  const endLast = segment.end & 255
  return `${startLast}-${endLast}.${parentZoneName(segment.start)}`
}

function defaultSerial(): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}00`
}

function header(segCidr: string, zone: string, serial: string): string {
  return [
    `; ============================================================`,
    `; 反向解析区域文件（由 VLSM 规划台生成，只读生成，不修改规划/登记）`,
    `; 网段：${segCidr}`,
    `; 区域：${zone}`,
    `; 序列号：${serial}`,
    `; 注意：SOA 与 NS 为占位模板（${PLACEHOLDER_NS} / ${PLACEHOLDER_RNAME}），`,
    `;       部署前请替换为实际权威名称服务器与管理员邮箱。`,
    `; ============================================================`,
  ].join('\n')
}

function soaLines(serial: string): string[] {
  return [
    '$TTL 86400',
    `@   IN  SOA ${PLACEHOLDER_NS} ${PLACEHOLDER_RNAME} (`,
    `        ${serial}  ; serial（YYYYMMDDnn）`,
    `        7200       ; refresh`,
    `        3600       ; retry`,
    `        1209600    ; expire`,
    `        3600 )     ; minimum`,
    '',
    `; 权威名称服务器（请替换占位值）`,
    `    IN  NS  ${PLACEHOLDER_NS}`,
  ]
}

/** 一条资源记录行：owner 列固定宽 4 字符、TYPE 列固定宽 6 字符，便于区域文件对齐阅读 */
function recordLine(lastOctet: number, type: 'PTR' | 'CNAME', target: string): string {
  return `${String(lastOctet).padEnd(4)} IN  ${type.padEnd(6)}${target}`
}

/** /24 标准反向区域文件（PTR） */
function buildClassfulZone(zone: string, segment: AllocSegment, entries: ReverseDnsEntry[], serial: string): string {
  const lines = [
    header(segment.cidr, zone, serial),
    `$ORIGIN ${zone}.`,
    ...soaLines(serial),
    '',
    '; PTR 记录（按 IP 地址升序）',
    ...entries.map((e) => recordLine(e.lastOctet, 'PTR', e.fqdn)),
  ]
  return `${lines.join('\n')}\n`
}

/** RFC 2317 父区域片段（追加进所属 /24 in-addr.arpa 区域）：每条登记一行 CNAME */
function buildRfc2317Parent(
  parentZone: string,
  childZone: string,
  segment: AllocSegment,
  entries: ReverseDnsEntry[],
  serial: string,
): string {
  const lines = [
    `; ============================================================`,
    `; RFC 2317 父区域 CNAME 片段（追加进现有区域 ${parentZone}.）`,
    `; 网段：${segment.cidr}（子区域 ${childZone}.）`,
    `; 序列号：${serial}`,
    `; 部署步骤：`,
    `;   1) 在父区域 ${parentZone}. 中加入下方委派（取消注释并替换 NS 占位值）：`,
    `;        ${segment.start & 255}-${segment.end & 255}  IN  NS  ${PLACEHOLDER_NS}`,
    `;   2) 逐条加入下列 CNAME（每条有效登记一行，按 IP 升序）；`,
    `;   3) 子区域文件使用本面板同步生成的“子区域 PTR”文本。`,
    `; ============================================================`,
    '',
    '; RFC 2317 CNAME（按 IP 地址升序）',
    ...entries.map((e) => recordLine(e.lastOctet, 'CNAME', `${e.lastOctet}.${childZone}.`)),
  ]
  return `${lines.join('\n')}\n`
}

/** RFC 2317 子区域文件（独立 zone，PTR） */
function buildRfc2317Child(
  childZone: string,
  segment: AllocSegment,
  entries: ReverseDnsEntry[],
  serial: string,
): string {
  const lines = [
    header(segment.cidr, childZone, serial),
    `$ORIGIN ${childZone}.`,
    ...soaLines(serial),
    '',
    '; PTR 记录（按 IP 地址升序）',
    ...entries.map((e) => recordLine(e.lastOctet, 'PTR', e.fqdn)),
  ]
  return `${lines.join('\n')}\n`
}

/**
 * 依据当前规划与登记为所选网段生成反向 DNS 区域视图。
 * 规划或登记变化后调用方会重新执行本函数，输出随之实时刷新。
 */
export function buildReverseDns(
  assignments: HostAssignment[],
  result: PlanResult,
  ownerId: string,
  options: ReverseDnsOptions = {},
): ReverseDnsResult | null {
  const segment = resolveReverseSegment(result, ownerId)
  if (!segment) return null

  const serial = options.serial ?? defaultSerial()
  const parentZone = parentZoneName(segment.start)

  let supported = true
  let unsupportedReason: string | undefined
  let mode: ReverseDnsMode
  if (segment.prefix === 24) {
    mode = 'classful'
  } else if (segment.prefix >= RFC2317_MIN_PREFIX && segment.prefix <= RFC2317_MAX_PREFIX) {
    mode = 'rfc2317'
  } else {
    supported = false
    mode = segment.prefix < 24 ? 'classful' : 'rfc2317'
    unsupportedReason =
      segment.prefix < 24
        ? `网段 ${segment.cidr} 大于 /24（/${segment.prefix}），反向区域超出单个 in-addr.arpa /24，不在本面板支持范围`
        : `网段 ${segment.cidr} 为 /${segment.prefix}：/31、/32 没有可用主机地址，不生成反向区域（仅支持 /24 与 /25～/30）`
  }

  if (!supported) {
    return {
      supported: false,
      unsupportedReason,
      mode,
      segment,
      parentZone,
      skipped: [],
      excluded: [],
      entries: [],
      errors: [],
      serial,
      zoneText: '',
      parentText: '',
      childText: '',
    }
  }

  // 只取所属网段的登记行；失效登记（越界/网络/广播/重复地址/孤儿）不参与、不阻断
  const { rows } = reconcileHosts(assignments, result)
  const ownRows = rows
    .filter((r) => r.assignment.ownerId === ownerId && r.valid)
    .sort((a, b) => a.assignment.address - b.assignment.address)
  const excluded: ReverseDnsExcludedRow[] = rows
    .filter((r) => r.assignment.ownerId === ownerId && !r.valid)
    .map((r) => ({
      assignment: r.assignment,
      ip: intToIp(r.assignment.address),
      reason: r.reasonText ?? '登记在当前规划下失效',
    }))

  const skipped: ReverseDnsSkippedRow[] = []
  const entries: ReverseDnsEntry[] = []
  const errors: ReverseDnsError[] = []
  // 归一域名（去尾点、转小写）-> 首次出现的行序号；重复域名从第二条起报错
  const firstFqdnIndex = new Map<string, number>()

  ownRows.forEach((row, i) => {
    const index = i + 1
    const { assignment } = row
    const ip = intToIp(assignment.address)
    const verdict = classifyDeviceName(assignment.name)
    if (verdict.kind === 'skip') {
      skipped.push({ assignment, ip })
      return
    }
    if (verdict.kind === 'error') {
      errors.push({
        index,
        assignment,
        ip,
        name: assignment.name,
        message: `设备名“${assignment.name || '（空）'}”不是合法绝对域名：${verdict.message}`,
      })
      return
    }
    const duplicateKey = verdict.fqdn.replace(/\.$/, '').toLowerCase()
    const first = firstFqdnIndex.get(duplicateKey)
    if (first !== undefined) {
      errors.push({
        index,
        assignment,
        ip,
        name: assignment.name,
        message: `域名 ${verdict.fqdn} 与第 ${first} 条登记重复（反向区域中域名必须唯一）`,
      })
      return
    }
    firstFqdnIndex.set(duplicateKey, index)
    entries.push({
      assignment,
      ip,
      rawName: assignment.name.trim(),
      fqdn: verdict.fqdn,
      address: assignment.address,
      lastOctet: assignment.address & 255,
    })
  })

  // 任一错误都停止整体生成：不输出任何区域文本（结果仍按 IP 升序预览有效行）
  if (errors.length > 0 || entries.length === 0) {
    return {
      supported: true,
      mode,
      segment,
      parentZone,
      ...(mode === 'rfc2317' ? { childZone: childZoneName(segment) } : {}),
      skipped,
      excluded,
      entries,
      errors,
      serial,
      zoneText: '',
      ...(mode === 'rfc2317' ? { parentText: '', childText: '' } : {}),
    }
  }

  if (mode === 'classful') {
    return {
      supported: true,
      mode,
      segment,
      parentZone,
      skipped,
      excluded,
      entries,
      errors,
      serial,
      zoneText: buildClassfulZone(parentZone, segment, entries, serial),
    }
  }

  const childZone = childZoneName(segment)
  return {
    supported: true,
    mode,
    segment,
    parentZone,
    childZone,
    skipped,
    excluded,
    entries,
    errors,
    serial,
    zoneText: '',
    parentText: buildRfc2317Parent(parentZone, childZone, segment, entries, serial),
    childText: buildRfc2317Child(childZone, segment, entries, serial),
  }
}

/** 下载区域文本为 .arpa / .zone 文件（Blob 方式，纯前端，不经过任何服务器） */
function downloadZone(text: string, filename: string) {
  const blob = new Blob([text.endsWith('\n') ? text : `${text}\n`], {
    type: 'text/plain;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/** /24 区域文件下载名，如 10.168.192.in-addr.arpa-2026-09-18T00-00-00.zone */
export function downloadClassfulZone(result: ReverseDnsResult) {
  downloadZone(result.zoneText, `${result.parentZone}-${timestamp()}.zone`)
}

/** RFC 2317 父区域片段下载名 */
export function downloadRfc2317Parent(result: ReverseDnsResult) {
  downloadZone(result.parentText ?? '', `${result.parentZone}-rfc2317-parent-${timestamp()}.zone`)
}

/** RFC 2317 子区域文件下载名，如 16-19.10.168.192.in-addr.arpa-...zone */
export function downloadRfc2317Child(result: ReverseDnsResult) {
  downloadZone(result.childText ?? '', `${result.childZone}-${timestamp()}.zone`)
}
