import { useMemo, useState } from 'react'
import { blocksToCidrList, summarizeSegments } from '../lib/summary'
import PlanPauseNote from './PlanPauseNote'
import type { PlanResult, Segment } from '../lib/types'

interface Props {
  result: PlanResult
  planning?: boolean
  planError?: string | null
}

/** 成功分配、带稳定 ownerId 的固定/自动网段 */
type AllocSegment = Segment & { ownerId: string; kind: 'fixed' | 'auto' }

const KIND_LABEL = { fixed: '固定', auto: '自动' } as const

function isAllocSegment(s: Segment): s is AllocSegment {
  return (s.kind === 'fixed' || s.kind === 'auto') && !!s.ownerId
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

export default function RouteSummaryPanel({ result, planning = false, planError = null }: Props) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)

  const planPaused = planning || planError !== null

  // 可勾选对象：当前成功分配的固定 / 自动网段（稳定 ownerId）
  const allocatable = useMemo(
    () => (planPaused ? [] : result.segments.filter(isAllocSegment)),
    [planPaused, result],
  )

  // 规划变化后，移除已不存在或分配失败的选择（同一 ID 重新成功分配时自动保留）
  const validIds = useMemo(() => new Set(allocatable.map((s) => s.ownerId)), [allocatable])
  const chosenIds = useMemo(
    () => new Set([...selectedIds].filter((id) => validIds.has(id))),
    [selectedIds, validIds],
  )

  const invalid = result.inputErrors.length > 0
  const disabled = planPaused || invalid || allocatable.length === 0

  const chosenSegments = useMemo(
    () => allocatable.filter((s) => chosenIds.has(s.ownerId)),
    [allocatable, chosenIds],
  )

  const summary = useMemo(() => summarizeSegments(chosenSegments), [chosenSegments])

  const allSelected = allocatable.length > 0 && chosenIds.size === allocatable.length

  function toggle(id: string) {
    setCopied(false)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setCopied(false)
    setSelectedIds(allSelected ? new Set() : new Set(allocatable.map((s) => s.ownerId)))
  }

  async function handleCopy() {
    if (summary.blocks.length === 0) return
    const ok = await copyText(blocksToCidrList(summary.blocks))
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }

  function disabledReason(): string {
    if (planPaused) return '' // 由 PlanPauseNote 展示计算中 / 异常提示
    if (invalid) return '输入非法（请先修正左侧错误），路由汇总已禁用。'
    if (allocatable.length === 0) return '当前没有成功分配的固定或自动网段，路由汇总已禁用。'
    return ''
  }

  return (
    <div className={`panel summary-panel${disabled ? ' is-disabled' : ''}`}>
      <h2>⑤ 路由汇总</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        勾选当前<strong>成功分配</strong>的固定 / 自动网段，将所选地址并集转换为
        <strong> 数量最少且覆盖精确</strong>的 CIDR 列表（先合并相邻区间，再按地址对齐边界拆分）。
        只有同前缀、连续且同属一个上级网段的块才会聚合；汇总项不包含任何未选需求、保留区或空闲地址。
      </p>

      {planPaused && (
        <PlanPauseNote
          planning={planning}
          planError={planError}
          planningText="路由汇总已暂停，网段勾选已保留。"
        />
      )}
      {!planPaused && disabled && <div className="summary-disabled-note">{disabledReason()}</div>}

      <fieldset disabled={disabled} style={{ border: 'none', margin: 0, padding: 0 }}>
        <div className="btn-row summary-toolbar">
          <label className="summary-checkall">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              aria-label="全选/全不选可汇总网段"
            />
            {allSelected ? '全不选' : '全选'}（{chosenIds.size}/{allocatable.length}）
          </label>
          <button
            className="primary"
            onClick={handleCopy}
            disabled={summary.blocks.length === 0}
            title="复制按网络地址升序排列的纯 CIDR 列表（每行一个）"
          >
            {copied ? '✓ 已复制' : '📋 复制 CIDR 列表'}
          </button>
        </div>

        <ul className="summary-pick-list">
          {allocatable.length === 0 ? (
            <li className="summary-empty">暂无可汇总的网段。</li>
          ) : (
            allocatable.map((seg) => {
              const id = seg.ownerId
              return (
                <li key={id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosenIds.has(id)}
                      onChange={() => toggle(id)}
                    />
                    <span className={`badge ${seg.kind}`}>{KIND_LABEL[seg.kind]}</span>
                    <span className="summary-pick-name">{seg.name}</span>
                    <span className="mono summary-pick-cidr">{seg.cidr}</span>
                    <span className="summary-pick-size mono">{fmt(seg.capacity)} 地址</span>
                  </label>
                </li>
              )
            })
          )}
        </ul>

        {chosenIds.size > 0 ? (
          <>
            <div className="summary-meta-line">
              已选 {summary.selectedCount} 个网段，合计 <strong>{fmt(summary.totalAddresses)}</strong> 个地址
              → 汇总为 <strong>{summary.blocks.length}</strong> 个 CIDR
              {summary.blocks.some((b) => b.aggregated) && (
                <span className="summary-agg-hint">（其中 {summary.blocks.filter((b) => b.aggregated).length} 项由相邻网段聚合）</span>
              )}
            </div>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>汇总 CIDR</th>
                    <th style={{ textAlign: 'right' }}>地址数</th>
                    <th>覆盖的原需求（网段）</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.blocks.map((b, i) => (
                    <tr key={b.cidr} className={b.aggregated ? 'summary-aggregated' : ''}>
                      <td className="mono">{i + 1}</td>
                      <td className="mono">
                        {b.cidr}
                        {b.aggregated && <span className="agg-badge">聚合</span>}
                      </td>
                      <td style={{ textAlign: 'right' }} className="mono">
                        {fmt(b.capacity)}
                      </td>
                      <td>
                        {b.sources.length === 1 &&
                          b.sources[0].cidr === b.cidr &&
                          !b.aggregated ? (
                          <span className="summary-source-single">
                            {b.sources[0].name}
                            <span className="mono summary-src-cidr">{b.sources[0].cidr}</span>
                          </span>
                        ) : (
                          <ul className="summary-source-list">
                            {b.sources.map((src) => (
                              <li key={src.id}>
                                <span className={`badge ${src.kind}`}>{KIND_LABEL[src.kind]}</span>
                                {src.name}
                                <span className="mono summary-src-cidr">{src.cidr}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          !disabled && <p className="summary-empty">尚未勾选任何网段。勾选上方网段后这里将显示汇总结果。</p>
        )}
      </fieldset>
    </div>
  )
}
