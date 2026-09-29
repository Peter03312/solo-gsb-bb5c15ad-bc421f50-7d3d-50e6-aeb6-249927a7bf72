import { useMemo, useState } from 'react'
import { isAllocSegment } from '../lib/hosts'
import PlanPauseNote from './PlanPauseNote'
import {
  buildOption121,
  downloadOption121Conf,
  resolveClientSegment,
} from '../lib/option121'
import type { Option121RouteInput, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  clientId: string
  routes: Option121RouteInput[]
  onClientChange: (id: string) => void
  onRoutesChange: (next: Option121RouteInput[]) => void
  planning?: boolean
  planError?: string | null
}

const KIND_LABEL = { fixed: '固定', auto: '自动' } as const

let routeCounter = 0
function routeUid(): string {
  routeCounter += 1
  return `opt121-${Date.now()}-${routeCounter}`
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

export default function Option121Panel({
  result,
  clientId,
  routes,
  onClientChange,
  onRoutesChange,
  planning = false,
  planError = null,
}: Props) {
  const [copied, setCopied] = useState(false)

  const planPaused = planning || planError !== null

  // 可作为客户端网段的对象：当前成功分配的固定 / 自动网段（按地址升序）；
  // 计算期间沿用上一版清单展示选择，结果生成由 planPaused 统一暂停
  const allocatable = useMemo(() => {
    if (!planPaused && result.inputErrors.length > 0) return []
    return result.segments.filter(isAllocSegment)
  }, [planPaused, result])

  const invalid = !planPaused && result.inputErrors.length > 0
  // 选中的客户端网段在当前规划中失效（规划变化导致删除 / 分配失败）时暂停结果
  const client = useMemo(() => resolveClientSegment(result, clientId), [result, clientId])
  const clientMissing = !planPaused && !invalid && allocatable.length > 0 && clientId !== '' && !client

  // 暂停期间不生成合并结果（但路由录入仍可编辑）
  const built = useMemo(
    () => (!planPaused && client ? buildOption121(routes, client) : null),
    [planPaused, routes, client],
  )

  function patchRoute(id: string, patch: Partial<Option121RouteInput>) {
    onRoutesChange(routes.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  function addRoute() {
    onRoutesChange([...routes, { id: routeUid(), destination: '', gateway: '' }])
  }

  function removeRoute(id: string) {
    onRoutesChange(routes.filter((r) => r.id !== id))
  }

  async function handleCopy() {
    if (!built || !built.optionLine) return
    const ok = await copyText(built.optionLine)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }

  function handleDownload() {
    if (!built || !built.optionLine) return
    downloadOption121Conf(built.optionLine)
  }

  const errors = built?.errors ?? []
  const hasAnyEntry = built ? built.routes.length > 0 || built.rows.some((r) => !r.empty) : routes.length > 0
  const canOutput = !!built && errors.length === 0 && built.routes.length > 0

  return (
    <div className="panel opt121-panel">
      <h2>⑦ DHCP Option 121（无分类静态路由 / RFC 3442）</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        选择一个当前<strong>成功分配</strong>的固定 / 自动网段作为<strong>客户端网段</strong>，
        录入多条「目的 CIDR + 下一跳 IPv4」：目的须为规范网络地址（允许
        <code className="mono opt121-inline-code">0.0.0.0/0</code> 默认路由），
        下一跳必须是客户端网段内的可用主机地址（不能是网络 / 广播地址）。
        按<strong>目的前缀从长到短、网络地址升序</strong>生成 RFC 3442 字节：
        前缀长度后仅写入 <code className="mono opt121-inline-code">ceil(前缀/8)</code> 个目的网络字节，再写四个下一跳字节；
        重复目的或任一无效条目都会<strong>明确定位错误并停止整体生成</strong>。
        规划变化后按稳定 ID 保留全部录入并自动重新校验；网段失效时暂停结果、录入不丢失。
      </p>

      {planPaused && (
        <PlanPauseNote
          planning={planning}
          planError={planError}
          planningText="Option 121 结果生成已暂停，客户端网段选择与全部路由录入均已保留且仍可编辑。"
        />
      )}
      {invalid && (
        <div className="summary-disabled-note">
          输入非法（请先修正左侧错误），Option 121 结果生成已暂停；客户端网段选择与全部路由录入均已保留，修正后自动恢复。
        </div>
      )}
      {!planPaused && !invalid && allocatable.length === 0 && (
        <div className="summary-disabled-note">当前没有成功分配的固定或自动网段，暂无可选的客户端网段。</div>
      )}
      {clientMissing && (
        <div className="summary-disabled-note">
          已选择的客户端网段在当前规划中已失效（被删除或分配失败），结果已暂停；路由录入已保留，重新选择有效网段后恢复生成。
        </div>
      )}

      <div className="opt121-client-row">
        <label className="field-label" htmlFor="opt121-client">
          客户端网段（下一跳必须位于此网段的可用主机范围内）
        </label>
        <select
          id="opt121-client"
          className="opt121-select"
          value={clientId}
          onChange={(e) => {
            setCopied(false)
            onClientChange(e.target.value)
          }}
        >
          <option value="">— 请选择客户端网段 —</option>
          {allocatable.map((seg) => (
            <option key={seg.ownerId} value={seg.ownerId}>
              {`[${KIND_LABEL[seg.kind]}] ${seg.name}　${seg.cidr}（可用 ${seg.firstUsable} ~ ${seg.lastUsable}）`}
            </option>
          ))}
        </select>
      </div>

      {/* 计算期间保持录入可编辑：仅暂停生成，不禁用字段集（planPaused 时 built 为 null，不输出结果） */}
      <fieldset
        disabled={!client && !planPaused}
        className="opt121-fieldset"
        style={{ border: 'none', margin: 0, padding: 0 }}
      >
        <div className="btn-row opt121-toolbar">
          <button onClick={addRoute} disabled={!client && !planPaused}>
            + 添加路由条目
          </button>
          <span className="opt121-toolbar-hint">
            目的例：<code className="mono">192.168.1.0/24</code>、<code className="mono">10.0.0.0/8</code>、
            <code className="mono">0.0.0.0/0</code>
          </span>
        </div>

        <div className="opt121-rows">
          {routes.map((route) => {
            const view = built?.rows.find((r) => r.id === route.id) ?? null
            const rowErrors = view?.errors ?? []
            return (
              <div
                key={route.id}
                className={`opt121-row${rowErrors.length > 0 ? ' has-error' : ''}${view?.empty ? ' is-empty' : ''}`}
              >
                <div className="opt121-row-inputs">
                  <span className="opt121-idx mono">#{view?.index ?? ''}</span>
                  <input
                    type="text"
                    className="opt121-dest"
                    placeholder="目的 CIDR，如 192.168.1.0/24（允许 0.0.0.0/0）"
                    value={route.destination}
                    onChange={(e) => {
                      setCopied(false)
                      patchRoute(route.id, { destination: e.target.value })
                    }}
                  />
                  <input
                    type="text"
                    className="opt121-gw"
                    placeholder="下一跳 IPv4，须为客户端网段内可用主机"
                    value={route.gateway}
                    onChange={(e) => {
                      setCopied(false)
                      patchRoute(route.id, { gateway: e.target.value })
                    }}
                  />
                  <button
                    type="button"
                    className="icon"
                    title="删除该条目"
                    onClick={() => removeRoute(route.id)}
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
                  view && !view.empty && view.bytes && (
                    <div className="opt121-row-bytes mono">
                      {view.destination} → {view.gatewayIp}：{view.bytes.join(',')}
                      <span className="opt121-byte-count">（{view.bytes.length} 字节）</span>
                    </div>
                  )
                )}
              </div>
            )
          })}
        </div>
      </fieldset>

      {errors.length > 0 && (
        <div className="opt121-error-box">
          <strong>存在 {errors.length} 处条目错误，已停止生成（合并字节与 dhcp-option=121 配置暂不输出）：</strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>
                第 {e.index} 条：{e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {client && !hasAnyEntry && (
        <p className="summary-empty">添加至少一条有效路由后，这里将展示合并字节与 dnsmasq 配置。</p>
      )}

      {canOutput && built && (
        <div className="opt121-result">
          <div className="dnsmasq-head">
            <h3>合并结果（{built.routes.length} 条路由，共 {built.bytes.length} 字节）</h3>
            <div className="dnsmasq-actions">
              <button onClick={handleCopy} title="复制 dhcp-option=121 配置行">
                {copied ? '✓ 已复制' : '📋 复制'}
              </button>
              <button className="primary" onClick={handleDownload} title="下载为 dnsmasq 配置文件（.conf）">
                ⬇ 下载 .conf
              </button>
            </div>
          </div>

          <div className="table-scroll">
            <table className="opt121-table">
              <thead>
                <tr>
                  <th>下发序</th>
                  <th>目的 CIDR</th>
                  <th>下一跳 IPv4</th>
                  <th>本条十进制字节</th>
                </tr>
              </thead>
              <tbody>
                {built.routes.map((r, i) => (
                  <tr key={`${r.destination}-${r.index}`}>
                    <td className="mono">{i + 1}</td>
                    <td className="mono">
                      {r.destination}
                      <span className="opt121-src-idx">（录入第 {r.index} 条）</span>
                    </td>
                    <td className="mono">{r.gatewayIp}</td>
                    <td className="mono opt121-bytes-cell">{r.bytes.join(',')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="opt121-merged">
            <span className="opt121-merged-label">合并字节：</span>
            <code className="mono">{built.bytes.join(',')}</code>
          </div>

          <p className="dnsmasq-hint">
            可直接追加到 dnsmasq 配置（如 <code className="mono">/etc/dnsmasq.d/option121.conf</code>）后重新加载：
          </p>
          <pre className="mono dnsmasq-output">{built.optionLine}</pre>
        </div>
      )}
    </div>
  )
}
