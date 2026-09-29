import { useMemo, useState } from 'react'
import { buildDnsmasqLeases, dnsmasqLeasesText, downloadDnsmasqLeases } from '../lib/dnsmasq'
import type { HostAssignment, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
}

/** 复制到剪贴板；非安全上下文（无 navigator.clipboard）时回退到临时 textarea */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到回退方案
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** dnsmasq 静态租约生成区：纳入当前有效且具备合法 MAC 的登记，按 IPv4 升序输出 */
export default function DnsmasqLeases({ result, assignments }: Props) {
  const [copied, setCopied] = useState(false)

  // 规划或登记变化后实时重算（父组件 useMemo 结果变化即重新执行）
  const { leases, excluded } = useMemo(
    () => buildDnsmasqLeases(assignments, result),
    [assignments, result],
  )
  const text = useMemo(() => dnsmasqLeasesText(leases), [leases])

  async function handleCopy() {
    if (leases.length === 0) return
    const ok = await copyText(text)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }

  function handleDownload() {
    if (leases.length === 0) return
    downloadDnsmasqLeases(text)
  }

  return (
    <div className="dnsmasq-box">
      <div className="dnsmasq-head">
        <h3>dnsmasq 静态租约（dhcp-host）</h3>
        <div className="dnsmasq-actions">
          <button onClick={handleCopy} disabled={leases.length === 0} title="复制全部租约行">
            {copied ? '✓ 已复制' : '📋 复制'}
          </button>
          <button
            className="primary"
            onClick={handleDownload}
            disabled={leases.length === 0}
            title="下载为 dnsmasq 配置文件（.conf）"
          >
            ⬇ 下载 .conf
          </button>
        </div>
      </div>
      <p className="dnsmasq-hint">
        仅纳入当前规划中<strong>有效且填写合法 MAC</strong>的设备登记，按 IPv4 升序输出，每行
        <code className="mono">dhcp-host=&lt;MAC&gt;,&lt;IPv4&gt;</code>
        ，可直接加入 dnsmasq 配置；失效登记与未填写 MAC 的设备不会输出，仅在下方列出原因。
      </p>

      {leases.length === 0 ? (
        <div className="dnsmasq-empty">暂无可输出的租约：请先添加设备并填写合法 MAC。</div>
      ) : (
        <>
          <pre className="mono dnsmasq-output">{text}</pre>
          <div className="dnsmasq-count">共 {leases.length} 条静态租约</div>
        </>
      )}

      {excluded.length > 0 && (
        <div className="dnsmasq-excluded">
          <h4>未输出条目（{excluded.length}）</h4>
          <table className="host-table">
            <thead>
              <tr>
                <th>设备</th>
                <th>IPv4</th>
                <th>MAC</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {excluded.map((item) => (
                <tr key={item.assignment.id} className="host-invalid-row">
                  <td className="host-device-name">{item.assignment.name || '未命名设备'}</td>
                  <td className="mono host-addr">
                    <span className="host-addr-bad">{item.ip}</span>
                  </td>
                  <td className="mono host-mac-cell">
                    {item.assignment.mac ? (
                      item.assignment.mac
                    ) : (
                      <span className="host-mac-none">—</span>
                    )}
                  </td>
                  <td className="host-reason">
                    <span className="host-invalid-tag">{item.reason}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
