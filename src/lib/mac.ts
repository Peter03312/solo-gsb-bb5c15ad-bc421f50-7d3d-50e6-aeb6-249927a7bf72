// MAC 地址录入与校验：接受冒号或连字符分隔的六组两位十六进制，统一规范为小写冒号格式
// （如 AA-BB-CC-DD-EE-FF / aa:bb:cc:dd:ee:ff -> aa:bb:cc:dd:ee:ff）。
// 拒绝：格式非法（含混用分隔符、点分写法、位数不对等）、全零 MAC、
// 首字节最低位为 1（组播位）、与其他设备登记重复（全局去重，不限网段）。

import type { HostAssignment } from './types'

export interface MacCheckResult {
  /** 校验通过时的规范 MAC（小写冒号）；空输入表示不填写，为 undefined */
  mac?: string
  /** 校验失败时面向用户的拒绝原因 */
  error?: string
}

const COLON_RE = /^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/
const HYPHEN_RE = /^(?:[0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2}$/

/**
 * 仅做格式与语义规范，不查重：
 * 空串 -> { mac: undefined }（MAC 可暂不填写）；
 * 非法 -> { error }；合法 -> { mac: 小写冒号格式 }。
 */
export function normalizeMacInput(raw: string): MacCheckResult {
  const value = raw.trim()
  if (!value) return { mac: undefined }
  // 两条互斥正则保证六个两位十六进制组且分隔符统一（自然拒绝混用、点分写法与错误位数）
  if (!COLON_RE.test(value) && !HYPHEN_RE.test(value)) {
    return {
      error: `“${value}”不是合法 MAC：需为六组两位十六进制数，统一用冒号或连字符分隔（如 aa:bb:cc:dd:ee:ff）`,
    }
  }
  const groups = value.split(/[:-]/)
  const mac = groups.map((g) => g.toLowerCase()).join(':')
  if (groups.every((g) => g === '00')) {
    return { error: 'MAC 不能为全零 00:00:00:00:00:00' }
  }
  // IEEE 802：首字节最低位为 1 表示组播地址（含广播 ff:ff:ff:ff:ff:ff），不能标识单台设备
  if ((parseInt(groups[0], 16) & 0x01) === 1) {
    return {
      error: `MAC ${mac} 的首字节最低位为 1（组播位），组播地址不能作为单台设备的静态租约`,
    }
  }
  return { mac }
}

/**
 * 校验一条 MAC 录入（格式规范 + 与其他登记的全局去重）。
 * 空输入合法，表示该设备暂不填写 MAC（结果 mac 为 undefined）。
 * selfId 为当前编辑的登记 ID，编辑自身时其 MAC 不算重复。
 */
export function checkMac(
  raw: string,
  assignments: HostAssignment[],
  selfId?: string,
): MacCheckResult {
  const parsed = normalizeMacInput(raw)
  if (parsed.error || parsed.mac === undefined) return parsed
  const clash = assignments.find((a) => a.id !== selfId && a.mac === parsed.mac)
  if (clash) {
    return { error: `MAC ${parsed.mac} 与设备“${clash.name || '未命名'}”重复` }
  }
  return parsed
}
