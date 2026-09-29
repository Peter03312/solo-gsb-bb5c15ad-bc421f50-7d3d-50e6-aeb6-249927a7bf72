import { useMemo } from 'react'
import {
  fragmentPiece,
  listValidDevices,
  MAX_HOPS,
  MAX_MTU,
  MIN_MTU,
  parseMtu,
  parsePayload,
  simulateFragments,
  validateFragInput,
  type FragHopInput,
  type FragPiece,
} from '../lib/fragmentation'
import PlanPauseNote from './PlanPauseNote'
import type { HostAssignment, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
  deviceId: string
  payloadRaw: string
  df: boolean
  hops: FragHopInput[]
  onDeviceChange: (id: string) => void
  onPayloadChange: (raw: string) => void
  onDfChange: (df: boolean) => void
  onHopsChange: (hops: FragHopInput[]) => void
  planning?: boolean
  planError?: string | null
}

let hopCounter = 0
function hopUid(): string {
  hopCounter += 1
  return `frag-hop-${Date.now()}-${hopCounter}`
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** 单片负载范围，如 0～1479（1480 字节） */
function rangeText(p: FragPiece): string {
  return `${fmt(p.payloadStart)} ～ ${fmt(p.payloadEnd - 1)}`
}

/** 单片的来源说明（原样 / 拆分自哪片） */
function pieceTag(p: FragPiece): string {
  if (p.payloadStart === 0) return '首片'
  if (!p.mf) return '末片'
  return '中间片'
}

/** 预演面板：从有效主机登记选发送设备，本地逐跳模拟 IPv4 分片 */
export default function FragmentPanel({
  result,
  assignments,
  deviceId,
  payloadRaw,
  df,
  hops,
  onDeviceChange,
  onPayloadChange,
  onDfChange,
  onHopsChange,
  planning = false,
  planError = null,
}: Props) {
  const planPaused = planning || planError !== null
  // 当前有效主机登记（规划 / 登记变化实时重算；失效设备不会出现在清单里）。
  // 计算期间沿用上一版结果列出设备，预演生成由 planPaused 统一暂停。
  const devices = useMemo(() => listValidDevices(assignments, result), [assignments, result])
  const planInvalid = !planPaused && result.inputErrors.length > 0
  const selectedDevice = devices.find((d) => d.id === deviceId) ?? null
  // 已选设备失效（登记被删 / 改址失效 / 所属网段消失）：保留选择与输入，暂停预演
  const deviceMissing = !planPaused && !planInvalid && deviceId !== '' && !selectedDevice

  const validation = useMemo(
    () =>
      validateFragInput({
        deviceId,
        devices,
        payloadRaw,
        hops,
      }),
    [deviceId, devices, payloadRaw, hops],
  )
  const errors = validation.errors
  const errorOf = (field: 'device' | 'payload', hopIndex?: number) =>
    errors.find((e) => e.field === field && (hopIndex === undefined || e.hopIndex === hopIndex))
  const mtuErrorOf = (hopIndex: number) => errors.find((e) => e.field === 'mtu' && e.hopIndex === hopIndex)

  // 输入全部合法且设备有效才执行预演；任何字段非法或规划暂停时都暂停（保留全部输入）
  const sim = useMemo(() => {
    if (planPaused || planInvalid || deviceMissing || errors.length > 0) return null
    if (!selectedDevice || validation.payloadLen === undefined || !validation.mtus) return null
    return simulateFragments({ payloadLen: validation.payloadLen, df, mtus: validation.mtus })
  }, [planPaused, planInvalid, deviceMissing, errors, selectedDevice, validation, df])

  function patchHop(id: string, mtu: string) {
    onHopsChange(hops.map((h) => (h.id === id ? { ...h, mtu } : h)))
  }
  function addHop() {
    if (hops.length >= MAX_HOPS) return
    onHopsChange([...hops, { id: hopUid(), mtu: '' }])
  }
  function removeHop(id: string) {
    onHopsChange(hops.filter((h) => h.id !== id))
  }
  function moveHop(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= hops.length) return
    const next = hops.slice()
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    onHopsChange(next)
  }

  // 实时解析单字段用于输入框旁的即时提示（不阻断输入，非法只暂停预演）
  const payloadHint = useMemo(() => {
    const r = parsePayload(payloadRaw)
    return 'error' in r ? null : r.value
  }, [payloadRaw])

  return (
    <div className="panel frag-panel">
      <h2>⑫ IPv4 路径分片预演</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        从当前<strong>有效主机登记</strong>选择发送设备，输入负载字节数（{fmt(1)}～65515）、
        <strong>DF（不分片）开关</strong>与按经过顺序排列的 <strong>1～8 跳 MTU</strong>
        （68～65535 整数）。固定 IPv4 首部 20 字节、无选项，<strong>仅本地计算、不发送任何报文</strong>。
        每跳处理上一跳全部分片：总长度不超过 MTU 则原样通过；超过 MTU 且
        <strong> DF=1 时报告首个阻断跳并停止</strong>；<strong>DF=0</strong> 时取不超过 MTU 的最大负载拆分，
        除原始报文最后一片外负载均为 8 的倍数。后续跳可再次分片但<strong>绝不重组</strong>；
        偏移量始终相对原始负载、以 8 字节计，MF 仅在该片之后仍有原始数据时为 1。
        登记或规划变化实时重算；<strong>设备失效或输入非法时保留选择与全部输入并暂停预演</strong>。
      </p>

      {planPaused && (
        <PlanPauseNote
          planning={planning}
          planError={planError}
          planningText="分片预演已暂停，发送设备选择与全部参数录入均已保留且仍可编辑。"
        />
      )}
      {planInvalid && (
        <div className="summary-disabled-note">
          规划输入非法（请先修正左侧错误），分片预演已暂停；发送设备选择与全部参数录入均已保留，修正后自动恢复。
        </div>
      )}
      {!planPaused && !planInvalid && devices.length === 0 && (
        <div className="summary-disabled-note">
          当前没有有效主机登记，请先在「⑥ 主机地址分配」中为成功分配的网段登记设备，再回到本面板选择发送设备。
        </div>
      )}
      {deviceMissing && (
        <div className="summary-disabled-note">
          已选择的发送设备已失效（登记被删除、改址失效或所属网段消失），预演已暂停；设备选择与全部参数录入均已保留，
          重新选择有效设备后自动恢复。
        </div>
      )}

      <div className="frag-form">
        <div className="frag-field">
          <label className="field-label" htmlFor="frag-device">发送设备（仅列当前有效主机登记）</label>
          <select
            id="frag-device"
            className={`opt121-select${errorOf('device') ? ' frag-input-bad' : ''}`}
            value={deviceId}
            onChange={(e) => onDeviceChange(e.target.value)}
          >
            <option value="">— 请选择发送设备 —</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {`${d.name}　${d.ip}（${d.segmentName} ${d.segmentCidr}）`}
              </option>
            ))}
          </select>
          {errorOf('device') && <div className="frag-field-error">{errorOf('device')!.message}</div>}
          {selectedDevice && (
            <div className="frag-device-meta mono">
              源地址 {selectedDevice.ip} · {selectedDevice.segmentName} {selectedDevice.segmentCidr}
            </div>
          )}
        </div>

        <div className="frag-field frag-field-short">
          <label className="field-label" htmlFor="frag-payload">
            负载字节数（1～65515；总长度 = 负载 + 20 字节首部）
          </label>
          <input
            id="frag-payload"
            type="number"
            min={1}
            max={65515}
            step={1}
            className={errorOf('payload') ? 'frag-input-bad' : ''}
            placeholder="例如 1400"
            value={payloadRaw}
            onChange={(e) => onPayloadChange(e.target.value)}
          />
          {errorOf('payload') ? (
            <div className="frag-field-error">{errorOf('payload')!.message}</div>
          ) : (
            payloadHint !== null && (
              <div className="frag-field-hint mono">
                原始总长度 {fmt(payloadHint + 20)} 字节
              </div>
            )
          )}
        </div>

        <div className="frag-field frag-field-df">
          <label className="field-label">DF 标志（Don't Fragment）</label>
          <label className={`frag-df-check${df ? ' is-on' : ''}`}>
            <input type="checkbox" checked={df} onChange={(e) => onDfChange(e.target.checked)} />
            <span>{df ? 'DF=1：禁止分片，超 MTU 即在首个阻断跳丢弃并停止' : 'DF=0：允许逐跳分片'}</span>
          </label>
        </div>
      </div>

      <div className="frag-hops-head">
        <label className="field-label" style={{ marginBottom: 0 }}>
          路径 MTU（按报文经过顺序排列，{MAX_HOPS} 跳以内）
        </label>
      </div>
      <div className="frag-hop-list">
        {hops.map((hop, i) => {
          const err = mtuErrorOf(i + 1)
          return (
            <div key={hop.id} className={`frag-hop${err ? ' has-error' : ''}`}>
              <span className="frag-hop-idx mono">第 {i + 1} 跳</span>
              <input
                type="number"
                min={MIN_MTU}
                max={MAX_MTU}
                step={1}
                className="frag-hop-mtu"
                placeholder={`MTU ${MIN_MTU}～${MAX_MTU}`}
                value={hop.mtu}
                onChange={(e) => patchHop(hop.id, e.target.value)}
              />
              <span className="frag-hop-unit mono">
                字节{(() => {
                  const r = parseMtu(hop.mtu)
                  return 'error' in r ? '' : `（单包负载上限 ${fmt(r.value - 20)}）`
                })()}
              </span>
              <span className="frag-hop-arrows">
                <button type="button" className="icon" title="前移（更靠近发送设备）" disabled={i === 0} onClick={() => moveHop(i, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="icon"
                  title="后移（更靠近接收端）"
                  disabled={i === hops.length - 1}
                  onClick={() => moveHop(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="icon"
                  title="删除该跳"
                  disabled={hops.length <= 1}
                  onClick={() => removeHop(hop.id)}
                >
                  ✕
                </button>
              </span>
              {err && <div className="frag-field-error">第 {i + 1} 跳：{err.message}</div>}
            </div>
          )
        })}
      </div>
      <div className="btn-row opt121-toolbar">
        <button onClick={addHop} disabled={hops.length >= MAX_HOPS}>
          + 添加一跳
        </button>
        <span className="opt121-toolbar-hint">
          常见 MTU：以太网 <code className="mono">1500</code>、PPPoE <code className="mono">1492</code>、隧道
          <code className="mono">1400</code>，最小 IPv4 MTU <code className="mono">68</code>
        </span>
      </div>

      {errors.length > 0 && (
        <div className="opt121-error-box">
          <strong>输入存在 {errors.length} 处问题，预演已暂停（修正前不会输出逐跳结果）：</strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>
                {e.field === 'mtu' ? `第 ${e.hopIndex} 跳 MTU：` : e.field === 'payload' ? '负载字节数：' : '发送设备：'}
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {sim && (
        <div className="frag-result">
          <div className="pool-meta-row">
            <span className="rdns-chip">
              发送设备 <strong>{selectedDevice?.name}</strong>{' '}
              <strong className="mono">{selectedDevice?.ip}</strong>
            </span>
            <span className="rdns-chip mono">原始负载 {fmt(sim.payloadLen)} 字节</span>
            <span className="rdns-chip mono">原始总长度 {fmt(sim.payloadLen + 20)} 字节</span>
            <span className="rdns-chip mono">DF = {sim.df ? 1 : 0}</span>
            <span className={`rdns-chip${sim.blocked ? ' is-zero' : ''}`}>
              {sim.blocked ? `阻断于第 ${sim.blockedHopIndex} 跳` : `全程 ${sim.hops.length} 跳通过`}
            </span>
          </div>

          {sim.blocked && (
            <div className="frag-blocked-box">
              <strong>🛑 首个阻断跳：第 {sim.blockedHopIndex} 跳（MTU {sim.hops[sim.blockedHopIndex! - 1].mtu}）</strong>
              <div>{sim.hops[sim.blockedHopIndex! - 1].blocked?.message}</div>
            </div>
          )}

          {sim.hops.map((hop) => (
            <div key={hop.hopIndex} className={`frag-hop-outcome${hop.blocked ? ' is-blocked' : ''}`}>
              <div className="frag-hop-outcome-head">
                <h3>
                  第 {hop.hopIndex} 跳 · MTU {fmt(hop.mtu)}
                </h3>
                <span className="frag-hop-stat mono">
                  进入 {fmt(hop.inCount)} 片 → 输出 {fmt(hop.outCount)} 片
                </span>
                {hop.blocked && <span className="frag-badge frag-badge-block">阻断</span>}
                {!hop.blocked && hop.outCount > hop.pieces.length && (
                  <span className="frag-badge frag-badge-split">发生分片</span>
                )}
                {!hop.blocked && hop.outCount === 1 && hop.pieces.length === 1 && hop.pieces[0].passed && (
                  <span className="frag-badge frag-badge-pass">原样通过</span>
                )}
                {!hop.blocked && hop.outCount > 1 && hop.pieces.every((p) => p.passed) && (
                  <span className="frag-badge frag-badge-pass">全部原样通过</span>
                )}
              </div>
              <div className="table-scroll">
                <table className="opt121-table frag-table">
                  <thead>
                    <tr>
                      <th>来源片负载范围</th>
                      <th>处置</th>
                      <th>输出片负载范围</th>
                      <th>负载字节</th>
                      <th>总长度</th>
                      <th>偏移量（×8 字节）</th>
                      <th>MF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hop.pieces.map((pp, i) => (
                      <HopPieceRows key={i} pp={pp} blocked={!!hop.blocked} mtu={hop.mtu} payloadLen={sim.payloadLen} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="frag-summary">
            <h3>
              {sim.blocked
                ? sim.blockedHopIndex === 1
                  ? '阻断统计（报文未能通过第 1 跳，保持原始报文形态）'
                  : `阻断前（第 ${sim.blockedHopIndex! - 1} 跳后）统计`
                : '最终统计'}
            </h3>
            <div className="pool-meta-row">
              <span className="rdns-chip">
                片数 <strong>{fmt(sim.pieceCount)}</strong>
              </span>
              <span className="rdns-chip mono">
                首部开销 {fmt(sim.pieceCount)} × 20 = <strong>{fmt(sim.headerOverhead)}</strong> 字节
              </span>
              <span className="rdns-chip mono">
                全部片总长度合计 <strong>{fmt(sim.totalBytes)}</strong> 字节
              </span>
              <span className="rdns-chip mono">
                负载守恒 {fmt(sim.finalPieces.reduce((s, p) => s + p.payloadLen, 0))} = {fmt(sim.payloadLen)} 字节
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 单个来源片在一跳中的渲染：通过展开一行；拆分展开每个子片一行；阻断展开一行红字 */
function HopPieceRows({
  pp,
  blocked,
  mtu,
  payloadLen,
}: {
  pp: { piece: FragPiece; passed: boolean; splitInto?: FragPiece[] }
  blocked: boolean
  mtu: number
  payloadLen: number
}) {
  if (pp.passed) {
    return (
      <tr>
        <td className="mono">{rangeText(pp.piece)}</td>
        <td><span className="frag-badge frag-badge-pass">通过</span></td>
        <td className="mono">{rangeText(pp.piece)}</td>
        <td className="mono">{fmt(pp.piece.payloadLen)}</td>
        <td className="mono">{fmt(pp.piece.totalLen)}</td>
        <td className="mono">{pp.piece.offset}</td>
        <td className="mono">{pp.piece.mf ? 1 : 0}</td>
      </tr>
    )
  }
  if (blocked) {
    return (
      <tr className="frag-row-blocked">
        <td className="mono">{rangeText(pp.piece)}</td>
        <td><span className="frag-badge frag-badge-block">丢弃</span></td>
        <td className="mono frag-muted">—（总长度 {fmt(pp.piece.totalLen)} &gt; MTU {fmt(mtu)}，DF=1）—</td>
        <td className="mono frag-muted">—</td>
        <td className="mono frag-muted">{fmt(pp.piece.totalLen)}</td>
        <td className="mono frag-muted">{pp.piece.offset}</td>
        <td className="mono frag-muted">{pp.piece.mf ? 1 : 0}</td>
      </tr>
    )
  }
  const children = pp.splitInto ?? fragmentPiece(pp.piece, mtu, payloadLen)
  return (
    <>
      {children.map((c) => (
        <tr key={`${c.payloadStart}-${c.payloadEnd}`} className="frag-row-split">
          <td className="mono frag-src-range">
            {rangeText(pp.piece)}
            <span className="frag-src-tag">{pieceTag(pp.piece)}</span>
          </td>
          <td><span className="frag-badge frag-badge-split">拆分</span></td>
          <td className="mono">
            {rangeText(c)}
            <span className="frag-src-tag">{pieceTag(c)}</span>
          </td>
          <td className="mono">{fmt(c.payloadLen)}</td>
          <td className="mono">{fmt(c.totalLen)}</td>
          <td className="mono">{c.offset}</td>
          <td className="mono">
            {c.mf ? <strong className="frag-mf-on">1</strong> : 0}
          </td>
        </tr>
      ))}
    </>
  )
}
