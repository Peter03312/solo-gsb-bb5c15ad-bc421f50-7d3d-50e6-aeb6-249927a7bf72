import { useMemo, useState } from 'react'
import { isAllocSegment } from '../lib/hosts'
import PlanPauseNote from './PlanPauseNote'
import {
  buildReverseDns,
  downloadClassfulZone,
  downloadRfc2317Child,
  downloadRfc2317Parent,
} from '../lib/reverseDns'
import type { HostAssignment, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
  ownerId: string
  onOwnerChange: (id: string) => void
  planning?: boolean
  planError?: string | null
}

const KIND_LABEL = { fixed: '固定', auto: '自动' } as const

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

type CopyKey = 'zone' | 'parent' | 'child'

/** 反向 DNS 区域文件面板：选择成功网段，读取其中有效且设备名为合法绝对域名的登记 */
export default function ReverseDnsPanel({
  result,
  assignments,
  ownerId,
  onOwnerChange,
  planning = false,
  planError = null,
}: Props) {
  const [copiedKey, setCopiedKey] = useState<CopyKey | null>(null)

  const planPaused = planning || planError !== null

  // 可选对象：当前成功分配的固定 / 自动网段（按地址升序，与规划结果顺序一致）；
  // 计算期间沿用上一版清单展示选择，结果生成由 planPaused 统一暂停
  const allocatable = useMemo(() => {
    if (!planPaused && result.inputErrors.length > 0) return []
    return result.segments.filter(isAllocSegment)
  }, [planPaused, result])

  const invalid = !planPaused && result.inputErrors.length > 0
  const segment = useMemo(
    () => allocatable.find((s) => s.ownerId === ownerId) ?? null,
    [allocatable, ownerId],
  )
  const segmentMissing = !planPaused && !invalid && allocatable.length > 0 && ownerId !== '' && !segment

  // 暂停期间不生成区域文件（网段选择保留）
  const built = useMemo(
    () => (!planPaused && segment ? buildReverseDns(assignments, result, segment.ownerId) : null),
    [planPaused, assignments, result, segment],
  )

  async function handleCopy(key: CopyKey, text: string) {
    if (!text) return
    const ok = await copyText(text)
    if (ok) {
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey(null), 2000)
    }
  }

  const hasErrors = !!built && built.errors.length > 0
  const canClassful = !!built && built.supported && built.mode === 'classful' && !hasErrors && built.zoneText !== ''
  const canRfc2317 =
    !!built && built.supported && built.mode === 'rfc2317' && !hasErrors && !!built.parentText && !!built.childText

  return (
    <div className="panel opt121-panel">
      <h2>⑧ 反向 DNS 区域文件（in-addr.arpa / RFC 2317）</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        选择一个当前<strong>成功分配</strong>的固定 / 自动网段，读取其中当前<strong>有效</strong>
        （地址仍在所属网段可用范围内、未重复）且设备名为<strong>合法绝对域名</strong>的主机登记：
        <code className="mono opt121-inline-code">/24</code> 生成标准 in-addr.arpa 区域的
        <strong> PTR</strong> 记录；<code className="mono opt121-inline-code">/25～/30</code> 按
        <strong> RFC 2317</strong> 为每条登记生成<strong>父区域 CNAME</strong> 与
        <strong>子区域 PTR</strong> 两段文本（子区域以网段起止末位命名）。
        单标签设备名（如「网关」）跳过；<strong>重复域名或不合法名称逐条报错并停止整体生成</strong>。
        网段迁移、登记增删或改址后实时重算；本面板只读，不修改规划与登记。
      </p>

      {planPaused && (
        <PlanPauseNote
          planning={planning}
          planError={planError}
          planningText="反向 DNS 区域生成已暂停，网段选择已保留。"
        />
      )}
      {invalid && (
        <div className="summary-disabled-note">
          输入非法（请先修正左侧错误），反向 DNS 区域生成已暂停；网段选择已保留，修正后自动恢复。
        </div>
      )}
      {!planPaused && !invalid && allocatable.length === 0 && (
        <div className="summary-disabled-note">当前没有成功分配的固定或自动网段，暂无可选网段。</div>
      )}
      {segmentMissing && (
        <div className="summary-disabled-note">
          已选择的网段在当前规划中已失效（被删除或分配失败），结果已暂停；重新选择有效网段后恢复生成。
        </div>
      )}

      <div className="opt121-client-row">
        <label className="field-label" htmlFor="rdns-segment">
          选择网段（仅读取该网段内有效且设备名为合法绝对域名的登记）
        </label>
        <select
          id="rdns-segment"
          className="opt121-select"
          value={ownerId}
          onChange={(e) => {
            setCopiedKey(null)
            onOwnerChange(e.target.value)
          }}
        >
          <option value="">— 请选择网段 —</option>
          {allocatable.map((seg) => (
            <option key={seg.ownerId} value={seg.ownerId}>
              {`[${KIND_LABEL[seg.kind]}] ${seg.name}　${seg.cidr}（可用 ${seg.firstUsable} ~ ${seg.lastUsable}）`}
            </option>
          ))}
        </select>
      </div>

      {built && !built.supported && (
        <div className="summary-disabled-note">{built.unsupportedReason}</div>
      )}

      {built && built.supported && (
        <>
          <div className="rdns-meta-row">
            <span className="rdns-chip">
              模式：{built.mode === 'classful' ? '标准 /24（PTR）' : 'RFC 2317（父 CNAME + 子 PTR）'}
            </span>
            <span className="rdns-chip mono">父区域：{built.parentZone}</span>
            {built.childZone && <span className="rdns-chip mono">子区域：{built.childZone}</span>}
            <span className="rdns-chip">
              有效登记 <strong>{built.entries.length}</strong> 条
            </span>
            <span className="rdns-chip">SOA 序列号（占位）：{built.serial}</span>
          </div>

          {/* 结果预览：按 IP 升序 */}
          {(built.entries.length > 0 || built.skipped.length > 0 || built.excluded.length > 0 || hasErrors) && (
            <div className="table-scroll">
              <table className="opt121-table">
                <thead>
                  <tr>
                    <th>序</th>
                    <th>IPv4（升序）</th>
                    <th>设备名（登记原文）</th>
                    <th>反向记录</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {built.entries.map((e, i) => (
                    <tr key={e.assignment.id}>
                      <td className="mono">{i + 1}</td>
                      <td className="mono">{e.ip}</td>
                      <td>{e.rawName}</td>
                      <td className="mono">
                        {built.mode === 'classful'
                          ? `${e.lastOctet} → ${e.fqdn}`
                          : `CNAME ${e.lastOctet}.${built.childZone}. / PTR ${e.fqdn}`}
                      </td>
                      <td>
                        <span className="rdns-ok">纳入</span>
                      </td>
                    </tr>
                  ))}
                  {built.skipped.map((s) => (
                    <tr key={s.assignment.id} className="rdns-skip-row">
                      <td className="mono">—</td>
                      <td className="mono">{s.ip}</td>
                      <td>{s.assignment.name.trim() || '（空）'}</td>
                      <td className="mono">—</td>
                      <td>
                        <span className="rdns-skip" title="不是多标签绝对域名（如仅填写了设备名），不参与生成">
                          跳过（非域名）
                        </span>
                      </td>
                    </tr>
                  ))}
                  {built.errors.map((e) => (
                    <tr key={e.assignment.id} className="host-invalid-row">
                      <td className="mono">{e.index}</td>
                      <td className="mono">
                        <span className="host-addr-bad">{e.ip}</span>
                      </td>
                      <td>{e.name || '（空）'}</td>
                      <td className="mono">—</td>
                      <td className="host-reason">
                        <span className="host-invalid-tag">{e.message}</span>
                      </td>
                    </tr>
                  ))}
                  {built.excluded.map((x) => (
                    <tr key={x.assignment.id} className="host-invalid-row">
                      <td className="mono">—</td>
                      <td className="mono">
                        <span className="host-addr-bad">{x.ip}</span>
                      </td>
                      <td>{x.assignment.name || '（空）'}</td>
                      <td className="mono">—</td>
                      <td className="host-reason">
                        <span className="host-invalid-tag" title="该登记在当前规划下失效，不读取；请到「⑥ 主机地址分配」处理">
                          未读取：{x.reason}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {hasErrors && (
            <div className="opt121-error-box">
              <strong>
                存在 {built.errors.length} 条名称错误，已停止整体生成（区域文件暂不输出）：
              </strong>
              <ul>
                {built.errors.map((e, i) => (
                  <li key={i}>
                    第 {e.index} 条（{e.ip}）：{e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!hasErrors && built.entries.length === 0 && (
            <p className="summary-empty">
              该网段当前没有可输出的有效绝对域名登记：请先在「⑥ 主机地址分配」中为设备登记
              <strong>合法绝对域名</strong>形式的设备名（如 <code className="mono">gw.example.com</code>）。
            </p>
          )}

          {/* /24：单一区域文件 */}
          {canClassful && (
            <div className="opt121-result">
              <div className="dnsmasq-head">
                <h3>
                  反向区域 <span className="mono">{built.parentZone}</span>（{built.entries.length} 条 PTR）
                </h3>
                <div className="dnsmasq-actions">
                  <button onClick={() => handleCopy('zone', built.zoneText)} title="复制完整区域文件">
                    {copiedKey === 'zone' ? '✓ 已复制' : '📋 复制区域文件'}
                  </button>
                  <button className="primary" onClick={() => downloadClassfulZone(built)} title="下载区域文件（.zone）">
                    ⬇ 下载区域文件
                  </button>
                </div>
              </div>
              <p className="dnsmasq-hint">
                标准 in-addr.arpa 区域文件，PTR 记录按 IP 升序；SOA / NS 为占位模板
                （<code className="mono">ns.example.com.</code>），部署前请替换。
              </p>
              <pre className="mono dnsmasq-output">{built.zoneText}</pre>
            </div>
          )}

          {/* /25～/30：RFC 2317 父区域 CNAME + 子区域 PTR 两段 */}
          {canRfc2317 && (
            <div className="opt121-result">
              <div className="rdns-block">
                <div className="dnsmasq-head">
                  <h3>
                    父区域 CNAME 片段 · <span className="mono">{built.parentZone}</span>（{built.entries.length} 条 CNAME）
                  </h3>
                  <div className="dnsmasq-actions">
                    <button onClick={() => handleCopy('parent', built.parentText ?? '')} title="复制父区域 CNAME 片段">
                      {copiedKey === 'parent' ? '✓ 已复制' : '📋 复制父区域片段'}
                    </button>
                    <button className="primary" onClick={() => downloadRfc2317Parent(built)} title="下载父区域片段（.zone）">
                      ⬇ 下载父区域片段
                    </button>
                  </div>
                </div>
                <p className="dnsmasq-hint">
                  追加进现有 <code className="mono">{built.parentZone}</code> 区域；
                  部署时还需按片段顶部注释加入对 <code className="mono">{built.childZone}</code> 的 NS 委派。
                </p>
                <pre className="mono dnsmasq-output">{built.parentText}</pre>
              </div>

              <div className="rdns-block">
                <div className="dnsmasq-head">
                  <h3>
                    子区域 PTR 文件 · <span className="mono">{built.childZone}</span>（{built.entries.length} 条 PTR）
                  </h3>
                  <div className="dnsmasq-actions">
                    <button onClick={() => handleCopy('child', built.childText ?? '')} title="复制子区域文件">
                      {copiedKey === 'child' ? '✓ 已复制' : '📋 复制子区域文件'}
                    </button>
                    <button className="primary" onClick={() => downloadRfc2317Child(built)} title="下载子区域文件（.zone）">
                      ⬇ 下载子区域文件
                    </button>
                  </div>
                </div>
                <p className="dnsmasq-hint">
                  RFC 2317 子区域（以网段起止末位 {built.segment.start & 255}-{built.segment.end & 255} 命名）的独立 zone 文件，PTR 按 IP 升序。
                </p>
                <pre className="mono dnsmasq-output">{built.childText}</pre>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
