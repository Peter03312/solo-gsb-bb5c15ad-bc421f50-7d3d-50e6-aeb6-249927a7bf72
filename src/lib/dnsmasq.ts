// dnsmasq 静态租约生成：只读取当前规划结果与主机登记，绝不修改规划、基线、路由汇总与 JSON 导出。
//
// 生成规则：
//   - 仅纳入当前规划中「有效」（地址仍在所属网段可用范围内）且具备合法 MAC 的登记；
//   - 失效登记（需求删除/分配失败/越界/网络地址/广播地址/重复）与未填写 MAC 的登记：
//     不输出，只在排除清单中列出原因；
//   - 输出按 IPv4 数值升序，每行 `dhcp-host=<MAC>,<IPv4>`。

import { intToIp } from './ip'
import { reconcileHosts } from './hosts'
import type { HostAssignment, PlanResult } from './types'

/** 一条进入输出的静态租约 */
export interface DnsmasqLease {
  assignment: HostAssignment
  mac: string
  address: number
  ip: string
}

/** 一条未进入输出的登记及原因 */
export interface DnsmasqExcluded {
  assignment: HostAssignment
  ip: string
  /** 排除原因（中文） */
  reason: string
}

export interface DnsmasqLeasesResult {
  leases: DnsmasqLease[]
  excluded: DnsmasqExcluded[]
}

function hostInvalidPrefix(reasonText?: string): string | null {
  return reasonText ? `登记失效：${reasonText}` : '登记失效'
}

/**
 * 依据当前规划重算全部登记，生成 dnsmasq 静态租约视图。
 * 规划变化后调用方会重新执行本函数，输出随之实时刷新。
 */
export function buildDnsmasqLeases(
  assignments: HostAssignment[],
  result: PlanResult,
): DnsmasqLeasesResult {
  const { rows } = reconcileHosts(assignments, result)
  const leases: DnsmasqLease[] = []
  const excluded: DnsmasqExcluded[] = []

  // 防御性重复检测：正常流程下 checkMac 已阻止重复 MAC 落库；
  // 若异常数据绕过校验（如旧数据），只保留录入最早的一条进入输出。
  const seenMac = new Set<string>()

  for (const row of rows) {
    const { assignment } = row
    const ip = intToIp(assignment.address)

    if (!row.valid) {
      excluded.push({ assignment, ip, reason: hostInvalidPrefix(row.reasonText) ?? '登记失效' })
      continue
    }
    if (!assignment.mac) {
      excluded.push({ assignment, ip, reason: '未填写 MAC' })
      continue
    }
    if (seenMac.has(assignment.mac)) {
      excluded.push({ assignment, ip, reason: `MAC ${assignment.mac} 与其他设备重复` })
      continue
    }
    seenMac.add(assignment.mac)
    leases.push({ assignment, mac: assignment.mac, address: assignment.address, ip })
  }

  leases.sort((a, b) => a.address - b.address)
  excluded.sort(
    (a, b) =>
      a.assignment.address - b.assignment.address ||
      a.assignment.name.localeCompare(b.assignment.name),
  )
  return { leases, excluded }
}

/** 输出文本：每行 `dhcp-host=<MAC>,<IPv4>`，按 IPv4 升序；无条目时为空串 */
export function dnsmasqLeasesText(leases: DnsmasqLease[]): string {
  return leases.map((l) => `dhcp-host=${l.mac},${l.ip}`).join('\n')
}

/** 下载为 .conf 文件（Blob 方式，纯前端，不经过任何服务器） */
export function downloadDnsmasqLeases(text: string) {
  const blob = new Blob([`${text}\n`], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  a.href = url
  a.download = `dnsmasq-dhcp-host-${stamp}.conf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
