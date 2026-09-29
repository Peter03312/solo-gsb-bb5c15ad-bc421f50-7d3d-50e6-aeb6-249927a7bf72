import { useMemo, useState } from 'react'
import { isAllocSegment } from '../lib/hosts'
import PlanPauseNote from './PlanPauseNote'
import {
  buildDhcpPool,
  downloadDhcpPoolConf,
  resolvePoolSegment,
} from '../lib/dhcpPool'
import type { DhcpExclusionInput, HostAssignment, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
  ownerId: string
  exclusions: DhcpExclusionInput[]
  onOwnerChange: (id: string) => void
  onExclusionsChange: (next: DhcpExclusionInput[]) => void
  planning?: boolean
  planError?: string | null
}

const KIND_LABEL = { fixed: '固定', auto: '自动' } as const

let exclCounter = 0
function exclUid(): string {
  exclCounter += 1
  return `dhcpx-${Date.now()}-${exclCounter}`
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
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

/** DHCP 动态地址池面板：选择成功网段，录入手工排除区间，输出 dhcp-range 配置 */
export default function DhcpPoolPanel({
  result,
  assignments,
  ownerId,
  exclusions,
  onOwnerChange,
  onExclusionsChange,
  planning = false,
  planError = null,
}: Props) {
  const [copied, setCopied] = useState(false)

  const planPaused = planning || planError !== null

  // 可作为宿主网段的对象：当前成功分配的固定 / 自动网段（按地址升序）；
  // 计算期间沿用上一版清单展示选择，结果生成由 planPaused 统一暂停
  const allocatable = useMemo(() => {
    if (!planPaused && result.inputErrors.length > 0) return []
    return result.segments.filter(isAllocSegment)
  }, [planPaused, result])

  const invalid = !planPaused && result.inputErrors.length > 0
  // 选中的宿主网段在当前规划中失效（规划变化导致删除 / 分配失败）时暂停结果
  const segment = useMemo(() => resolvePoolSegment(result, ownerId), [result, ownerId])
  const segmentMissing = !planPaused && !invalid && allocatable.length > 0 && ownerId !== '' && !segment

  // 暂停期间不生成地址池（排除区间录入仍可编辑）
  const built = useMemo(
    () => (!planPaused && segment ? buildDhcpPool(exclusions, assignments, result, segment) : null),
    [planPaused, exclusions, assignments, result, segment],
  )

  function patchExclusion(id: string, patch: Partial<DhcpExclusionInput>) {
    onExclusionsChange(exclusions.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }

  function addExclusion() {
    onExclusionsChange([...exclusions, { id: exclUid(), start: '', end: '' }])
  }

  function removeExclusion(id: string) {
    onExclusionsChange(exclusions.filter((x) => x.id !== id))
  }

  async function handleCopy() {
    if (!built || !built.configText) return
    const ok = await copyText(built.configText)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }

  function handleDownload() {
    if (!built || !built.configText || !segment) return
    downloadDhcpPoolConf(built.configText, segment)
  }

  const errors = built?.errors ?? []
  const hasAnyEntry = exclusions.length > 0
  const canOutput = !!built && errors.length === 0 && built.pools.length > 0

  return (
    <div className="panel opt121-panel dhcp-pool-panel">
      <h2>⑨ DHCP 动态地址池（dnsmasq dhcp-range）</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        选择一个当前<strong>成功分配</strong>的固定 / 自动网段，录入多段<strong>手工排除区间</strong>
        （起始 ~ 结束，结束留空表示仅排除单地址）。模块自动排除该网段的<strong>网络地址、广播地址</strong>
        及<strong>当前有效的主机登记</strong>，手工区间<strong>重叠或相邻会先合并</strong>，
        剩余地址按连续区间生成
        <code className="mono opt121-inline-code">dhcp-range=&lt;起始&gt;,&lt;结束&gt;,&lt;掩码&gt;</code>
        配置。排除区间必须位于所选网段且起止有序，任一无效条目都会<strong>明确定位错误并停止整体生成</strong>。
        规划、登记或排除项变化后实时重算；网段失效时暂停结果、录入不丢失。
      </p>

      {planPaused && (
        <PlanPauseNote
          planning={planning}
          planError={planError}
          planningText="DHCP 动态地址池生成已暂停，网段选择与全部排除区间录入均已保留且仍可编辑。"
        />
      )}
      {invalid && (
        <div className="summary-disabled-note">
          输入非法（请先修正左侧错误），DHCP 动态地址池生成已暂停；网段选择与全部排除区间录入均已保留，修正后自动恢复。
        </div>
      )}
      {!planPaused && !invalid && allocatable.length === 0 && (
        <div className="summary-disabled-note">当前没有成功分配的固定或自动网段，暂无可选的宿主网段。</div>
      )}
      {segmentMissing && (
        <div className="summary-disabled-note">
          已选择的宿主网段在当前规划中已失效（被删除或分配失败），结果已暂停；排除区间录入已保留，重新选择有效网段后恢复生成。
        </div>
      )}

      <div className="opt121-client-row">
        <label className="field-label" htmlFor="dhcp-pool-segment">
          宿主网段（网络地址、广播地址与该网段有效主机登记将被自动排除）
        </label>
        <select
          id="dhcp-pool-segment"
          className="opt121-select"
          value={ownerId}
          onChange={(e) => {
            setCopied(false)
            onOwnerChange(e.target.value)
          }}
        >
          <option value="">— 请选择宿主网段 —</option>
          {allocatable.map((seg) => (
            <option key={seg.ownerId} value={seg.ownerId}>
              {`[${KIND_LABEL[seg.kind]}] ${seg.name}　${seg.cidr}（可用 ${seg.firstUsable} ~ ${seg.lastUsable}）`}
            </option>
          ))}
        </select>
      </div>

      <fieldset
        disabled={!segment}
        className="opt121-fieldset"
        style={{ border: 'none', margin: 0, padding: 0 }}
      >
        {segment && built && (
          <div className="pool-meta-row">
            <span className="rdns-chip">
              网段 <strong className="mono">{segment.cidr}</strong>
            </span>
            <span className="rdns-chip mono">掩码 {built.netmask}</span>
            <span className="rdns-chip mono">
              可用主机 {segment.firstUsable} ~ {segment.lastUsable}（共 {fmt(segment.usable)} 个）
            </span>
            <span className="rdns-chip">
              自动排除主机登记 <strong>{built.hostExclusions.length}</strong> 个
            </span>
            <span className="rdns-chip">
              手工排除区间（合并后） <strong>{built.mergedManual.length}</strong> 段
            </span>
            <span className={`rdns-chip${built.total === 0 && errors.length === 0 ? ' is-zero' : ''}`}>
              可分配地址合计 <strong>{fmt(built.total)}</strong> 个 · 分成 <strong>{built.pools.length}</strong> 段
            </span>
          </div>
        )}

        <div className="btn-row opt121-toolbar">
          <button onClick={addExclusion} disabled={!segment}>
            + 添加排除区间
          </button>
          <span className="opt121-toolbar-hint">
            单地址示例：<code className="mono">192.168.10.20</code>；区间示例：
            <code className="mono">192.168.10.100 ~ 192.168.10.120</code>（结束留空即单地址）
          </span>
        </div>

        <div className="opt121-rows">
          {exclusions.map((ex) => {
            const view = built?.rows.find((r) => r.id === ex.id) ?? null
            const rowErrors = view?.errors ?? []
            return (
              <div
                key={ex.id}
                className={`opt121-row pool-row${rowErrors.length > 0 ? ' has-error' : ''}${view?.empty ? ' is-empty' : ''}`}
              >
                <div className="pool-row-inputs">
                  <span className="opt121-idx mono">#{view?.index ?? ''}</span>
                  <input
                    type="text"
                    className="pool-start"
                    placeholder="起始 IPv4（必填），如 192.168.10.100"
                    value={ex.start}
                    onChange={(e) => {
                      setCopied(false)
                      patchExclusion(ex.id, { start: e.target.value })
                    }}
                  />
                  <span className="pool-tilde mono">~</span>
                  <input
                    type="text"
                    className="pool-end"
                    placeholder="结束 IPv4（留空 = 仅排除起始单地址）"
                    value={ex.end}
                    onChange={(e) => {
                      setCopied(false)
                      patchExclusion(ex.id, { end: e.target.value })
                    }}
                  />
                  <button
                    type="button"
                    className="icon"
                    title="删除该区间"
                    onClick={() => removeExclusion(ex.id)}
                  >
                    ✕
                  </button>
                </div>
                {rowErrors.length > 0 ? (
                  <ul className="opt121-row-errors">
                    {rowErrors.map((m, j) => (
                      <li key={j}>第 {view?.index} 条：{m}</li>
                    ))}
                  </ul>
                ) : (
                  view && !view.empty && view.range && (
                    <div className="pool-row-ok mono">
                      {view.range.start === view.range.end
                        ? `排除单地址 ${view.startIp}`
                        : `排除 ${view.startIp} ~ ${view.endIp}（${fmt(view.range.end - view.range.start + 1)} 个地址）`}
                    </div>
                  )
                )}
              </div>
            )
          })}
        </div>

        {segment && built && built.mergedManual.length > 0 && (
          <div className="pool-merged">
            <span className="pool-merged-label">手工区间合并后（重叠 / 相邻自动合并）：</span>
            {built.mergedManual.map((m, i) => (
              <span key={i} className="pool-merged-chip mono">
                {m.startIp}
                {m.end !== m.start ? ` ~ ${m.endIp}` : ''}
                <em>（{fmt(m.count)}）</em>
              </span>
            ))}
          </div>
        )}

        {segment && built && built.hostExclusions.length > 0 && (
          <div className="pool-merged">
            <span className="pool-merged-label">自动排除的主机登记：</span>
            {built.hostExclusions.map((h) => (
              <span key={h.assignment.id} className="pool-merged-chip pool-host-chip mono" title={h.name}>
                {h.ip}
                <em>（{h.name}）</em>
              </span>
            ))}
          </div>
        )}
      </fieldset>

      {errors.length > 0 && (
        <div className="opt121-error-box">
          <strong>存在 {errors.length} 处排除区间错误，已停止生成（dhcp-range 配置暂不输出）：</strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>
                第 {e.index} 条：{e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {segment && !hasAnyEntry && (
        <p className="summary-empty">
          当前不排除任何手工区间：地址池即该网段全部可用主机地址（自动扣除网络地址、广播地址与有效主机登记）。
          添加排除区间或主机登记后，这里将实时展示分段结果与 dnsmasq 配置。
        </p>
      )}

      {segment && built && errors.length === 0 && built.pools.length === 0 && (
        <div className="dnsmasq-empty">
          可用主机地址已被全部排除（手工区间与有效主机登记覆盖了整个可用范围），暂无可分配地址。
        </div>
      )}

      {canOutput && built && segment && (
        <div className="opt121-result">
          <div className="dnsmasq-head">
            <h3>
              生成结果（{built.pools.length} 段地址池，共 {fmt(built.total)} 个可分配地址）
            </h3>
            <div className="dnsmasq-actions">
              <button onClick={handleCopy} title="复制全部 dhcp-range 配置行">
                {copied ? '✓ 已复制' : '📋 复制'}
              </button>
              <button className="primary" onClick={handleDownload} title="下载为 dnsmasq 配置文件（.conf）">
                ⬇ 下载 .conf
              </button>
            </div>
          </div>

          <div className="table-scroll">
            <table className="opt121-table pool-table">
              <thead>
                <tr>
                  <th>段</th>
                  <th>起始地址</th>
                  <th>结束地址</th>
                  <th>本段可分配数量</th>
                  <th>配置行</th>
                </tr>
              </thead>
              <tbody>
                {built.pools.map((p, i) => (
                  <tr key={`${p.start}-${p.end}`}>
                    <td className="mono">{i + 1}</td>
                    <td className="mono">{p.startIp}</td>
                    <td className="mono">{p.endIp}</td>
                    <td className="mono pool-count-cell">{fmt(p.count)}</td>
                    <td className="mono opt121-bytes-cell">{p.line}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>合计</td>
                  <td className="mono pool-count-cell">{fmt(built.total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="dnsmasq-hint">
            掩码 <code className="mono">{built.netmask}</code> 取自网段{' '}
            <code className="mono">{segment.cidr}</code>；可直接追加到 dnsmasq 配置（如{' '}
            <code className="mono">/etc/dnsmasq.d/dhcp-range.conf</code>）后重新加载。
            网络地址、广播地址与有效主机登记已自动扣除，不会出现在地址池中。
          </p>
          <pre className="mono dnsmasq-output">{built.configText}</pre>
        </div>
      )}
    </div>
  )
}
