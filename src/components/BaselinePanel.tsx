import { intToIp } from '../lib/ip'
import { formatRange } from '../lib/baseline'
import PlanPauseNote from './PlanPauseNote'
import ReflowReportPanel from './ReflowReport'
import type { Baseline, BaselineComparison, ChangeRow, ChangeType, PlanResult } from '../lib/types'

interface Props {
  baseline: Baseline | null
  result: PlanResult
  comparison: BaselineComparison | null
  onSave: () => void
  onClear: () => void
  /** 基线优先重排模式开关状态 */
  reflowEnabled: boolean
  onReflowChange: (enabled: boolean) => void
  /** 模式当前是否可用（存在基线且父网段与基线一致、输入合法） */
  reflowAvailable: boolean
  /** 规划 Worker 正在计算新输入（保存基线与对比统一暂停） */
  planning?: boolean
  /** 规划 Worker 异常信息 */
  planError?: string | null
}

const TYPE_META: Record<ChangeType, { label: string; cls: string }> = {
  added: { label: '新增', cls: 'added' },
  removed: { label: '删除', cls: 'removed' },
  unchanged: { label: '未变', cls: 'unchanged' },
  resized: { label: '容量变化', cls: 'resized' },
  migrated: { label: '迁移', cls: 'migrated' },
  unallocated: { label: '未分配', cls: 'unalloc' },
  recovered: { label: '恢复分配', cls: 'recovered' },
  'still-unallocated': { label: '仍未分配', cls: 'still-unalloc' },
}

const FILTER_TYPES: ChangeType[] = [
  'added',
  'removed',
  'migrated',
  'resized',
  'unallocated',
  'recovered',
  'still-unallocated',
  'unchanged',
]

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

function entryCidr(e: ChangeRow['baseline']): string {
  if (!e) return '—'
  return e.state === 'allocated' ? e.cidr ?? '—' : `未分配（${e.hosts} 台）`
}

function capacityText(row: ChangeRow): string {
  const b = row.baseline?.capacity
  const c = row.current?.capacity
  if (b !== undefined && c !== undefined && b !== c) {
    const diff = c - b
    const arrow = diff > 0 ? `扩容 +${fmtNum(diff)}` : `缩容 ${fmtNum(diff)}`
    return `${fmtNum(b)} → ${fmtNum(c)}（${arrow}）`
  }
  if (b !== undefined || c !== undefined) return fmtNum((c ?? b) as number)
  return '—'
}

function note(row: ChangeRow): string {
  if (row.type === 'removed') return '需求已从列表删除'
  if (row.type === 'added') return '基线保存后新增的需求'
  if (row.current?.state === 'unallocated') return row.current.reason ?? '无可用空间'
  if (row.type === 'migrated' && row.resize) {
    return row.resize === 'grow' ? '迁移并扩容' : '迁移并缩容'
  }
  if (row.type === 'recovered') return '基线时分配失败，现已恢复分配'
  return ''
}

function DiffBar({ comparison }: { comparison: BaselineComparison }) {
  const { occupied, released, still } = comparison.summary
  const all = [
    ...occupied.map((r) => ({ ...r, kind: 'new' as const })),
    ...released.map((r) => ({ ...r, kind: 'rel' as const })),
    ...still.map((r) => ({ ...r, kind: 'still' as const })),
  ].sort((a, b) => a.start - b.start)
  if (all.length === 0) return null

  const spanStart = all[0].start
  const spanEnd = all[all.length - 1].end
  const span = spanEnd - spanStart + 1

  const meta = {
    new: { label: '新占用', cls: 'new' },
    rel: { label: '释放', cls: 'rel' },
    still: { label: '仍占用', cls: 'still' },
  } as const

  return (
    <div className="bar-wrap">
      <div className="bar diff-bar" role="list" aria-label="基线对比地址变化条">
        {all.map((seg, i) => {
          const m = meta[seg.kind]
          const size = seg.end - seg.start + 1
          const pct = (size / span) * 100
          return (
            <div
              key={i}
              role="listitem"
              className={`bar-seg diff-${m.cls}`}
              style={{ flexGrow: size, flexBasis: `${Math.max(pct, 0.2)}%` }}
              title={`${m.label} · ${intToIp(seg.start)} ~ ${intToIp(seg.end)} · ${fmtNum(size)} 个地址`}
            />
          )
        })}
      </div>
      <div className="legend">
        <span>
          <span className="dot" style={{ background: 'var(--diff-new)' }} />
          新占用
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--diff-rel)' }} />
          释放
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--diff-still)' }} />
          仍占用
        </span>
        <span>悬停色块查看区间</span>
      </div>
    </div>
  )
}

function RangeList({ title, ranges, tone }: { title: string; ranges: { start: number; end: number }[]; tone: string }) {
  return (
    <div className="range-list">
      <div className="range-title">
        <span className={`dot`} style={{ background: tone }} />
        {title}（{fmtNum(ranges.reduce((a, r) => a + (r.end - r.start + 1), 0))}）
      </div>
      {ranges.length === 0 ? (
        <div className="range-empty">无</div>
      ) : (
        <ul className="mono">
          {ranges.map((r, i) => (
            <li key={i}>
              {formatRange(r)}
              <span className="range-size">{fmtNum(r.end - r.start + 1)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ChangeTable({ rows }: { rows: ChangeRow[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>变化</th>
            <th>名称</th>
            <th>基线网段</th>
            <th>当前网段</th>
            <th>容量（地址数）</th>
            <th style={{ textAlign: 'right' }}>需求主机</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const m = TYPE_META[row.type]
            const label =
              row.type === 'resized'
                ? row.resize === 'grow'
                  ? '扩容'
                  : '缩容'
                : m.label
            return (
              <tr key={row.id} className={`change-row ${m.cls}`}>
                <td>
                  <span className={`change-badge ${m.cls}`}>{label}</span>
                </td>
                <td>{row.name}</td>
                <td className="mono">{entryCidr(row.baseline)}</td>
                <td className="mono">{entryCidr(row.current)}</td>
                <td className="mono">{capacityText(row)}</td>
                <td style={{ textAlign: 'right' }} className="mono">
                  {row.hosts ?? '—'}
                </td>
                <td className="change-note">{note(row)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ReflowToggle({
  enabled,
  available,
  onToggle,
  hint,
}: {
  enabled: boolean
  available: boolean
  onToggle: (v: boolean) => void
  hint: string
}) {
  return (
    <div className={`reflow-toggle${available ? '' : ' disabled'}${enabled ? ' on' : ''}`}>
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          checked={enabled && available}
          disabled={!available}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>基线优先重排</span>
      </label>
      <span className="reflow-toggle-hint">
        {enabled && available
          ? '已启用：为每个基线自动需求优先保留包含原网络地址的对齐块，关闭后恢复原算法'
          : hint || '父网段与基线一致时可启用'}
      </span>
    </div>
  )
}

export default function BaselinePanel({
  baseline,
  result,
  comparison,
  onSave,
  onClear,
  reflowEnabled,
  onReflowChange,
  reflowAvailable,
  planning = false,
  planError = null,
}: Props) {
  const planPaused = planning || planError !== null
  // 计算中 / Worker 异常时禁止保存基线（只有当前版本的完整结果可作为基线）
  const canSave = !planPaused && result.inputErrors.length === 0 && result.segments.length > 0
  const paused = baseline !== null && (planPaused || result.inputErrors.length > 0)

  const reflowHint = !baseline
    ? '保存基线后可启用'
    : !reflowAvailable
      ? `仅在父网段与基线（${baseline.parentCidr}）完全一致时可用`
      : ''

  if (!baseline) {
    return (
      <div className="panel baseline-panel">
        <h2>④ 基线对比</h2>
        <p className="subtitle" style={{ marginBottom: 10 }}>
          把当前<strong>无输入错误</strong>的规划保存为基线后，再修改父 CIDR、保留区或需求，
          即可按需求的稳定 ID 对比新旧结果：新增、删除、未变、扩容/缩容、迁移（CIDR 改变）、
          未分配与恢复分配，并汇总地址区间的新占用、释放与净变化。基线仅保存在当前浏览器会话中。
        </p>
        <div className="btn-row">
          <button className="primary" onClick={onSave} disabled={!canSave}>
            保存当前规划为基线
          </button>
          {!canSave && !planPaused && result.inputErrors.length > 0 && (
            <span className="hint-warn">请先消除左侧输入错误</span>
          )}
        </div>
        <PlanPauseNote
          planning={planning}
          planError={planError}
          planningText="保存基线已暂停。"
        />
        <ReflowToggle
          enabled={false}
          available={false}
          onToggle={onReflowChange}
          hint={reflowHint}
        />
      </div>
    )
  }

  return (
    <div className="panel baseline-panel">
      <div className="header-row">
        <h2 style={{ marginBottom: 0 }}>
          ④ 基线对比
          <span className="baseline-meta mono">
            基线 {baseline.parentCidr} · {fmtTime(baseline.createdAt)}
          </span>
        </h2>
        <div className="btn-row" style={{ margin: 0 }}>
          <button onClick={onSave} disabled={!canSave} title="用当前规划覆盖基线">
            重建基线
          </button>
          <button className="danger-btn" onClick={onClear}>
            清除基线
          </button>
        </div>
      </div>

      <ReflowToggle
        enabled={reflowEnabled}
        available={reflowAvailable}
        onToggle={onReflowChange}
        hint={reflowHint}
      />

      {planPaused && (
        <PlanPauseNote
          planning={planning}
          planError={planError}
          planningText="基线对比与重建基线已暂停。"
        />
      )}

      {paused && !planPaused && (
        <div className="fail-box baseline-paused">
          <strong>当前输入存在错误，已保留基线并暂停对比。</strong>
          修正左侧输入后将自动恢复对比，基线不会丢失。
        </div>
      )}

      {!paused && comparison && (
        <>
          {baseline.parentCidr !== result.parentCidr && (
            <div className="fail-box" style={{ marginBottom: 12 }}>
              <strong>父 CIDR 已变更：</strong>
              <span className="mono">{baseline.parentCidr}</span> →{' '}
              <span className="mono">{result.parentCidr}</span>
              。地址区间按数值比较，跨网段时区间汇总可能为空或不连续，属正常现象。
            </div>
          )}
          <div className="change-status">
            {comparison.hasChanges ? (
              <span className="status-changed">
                与基线相比存在差异：
                {FILTER_TYPES.filter((t) => comparison.counts[t] > 0).map((t) => (
                  <span key={t} className={`change-badge ${TYPE_META[t].cls}`}>
                    {TYPE_META[t].label} {comparison.counts[t]}
                  </span>
                ))}
                <span className={`change-badge unchanged`}>未变 {comparison.counts.unchanged}</span>
              </span>
            ) : (
              <span className="status-same">✓ 当前规划与基线完全一致</span>
            )}
          </div>

          <div className="stat-grid diff-stats">
            <div className="stat">
              <div className="v" style={{ color: 'var(--diff-new)' }}>
                +{fmtNum(comparison.summary.occupiedCount)}
              </div>
              <div className="k">新占用地址</div>
            </div>
            <div className="stat">
              <div className="v" style={{ color: 'var(--diff-rel)' }}>
                −{fmtNum(comparison.summary.releasedCount)}
              </div>
              <div className="k">释放地址</div>
            </div>
            <div className="stat">
              <div className="v" style={{ color: 'var(--diff-still)' }}>
                {fmtNum(comparison.summary.stillCount)}
              </div>
              <div className="k">仍占用地址</div>
            </div>
            <div className="stat">
              <div
                className="v"
                style={{
                  color:
                    comparison.summary.net > 0
                      ? 'var(--diff-new)'
                      : comparison.summary.net < 0
                        ? 'var(--diff-rel)'
                        : undefined,
                }}
              >
                {comparison.summary.net > 0 ? '+' : ''}
                {fmtNum(comparison.summary.net)}
              </div>
              <div className="k">净地址变化（新占用 − 释放）</div>
            </div>
          </div>

          <div style={{ margin: '12px 0' }}>
            <DiffBar comparison={comparison} />
          </div>

          <div className="range-columns">
            <RangeList title="新占用区间" ranges={comparison.summary.occupied} tone="var(--diff-new)" />
            <RangeList title="释放区间" ranges={comparison.summary.released} tone="var(--diff-rel)" />
            <RangeList title="仍占用区间" ranges={comparison.summary.still} tone="var(--diff-still)" />
          </div>

          <h3 className="table-heading">需求级变化明细（按稳定 ID 对比，共 {comparison.rows.length} 项）</h3>
          <ChangeTable rows={comparison.rows} />
        </>
      )}

      {!paused && !planPaused && result.reflow && (
        <div style={{ marginTop: 18 }}>
          <ReflowReportPanel result={result} />
        </div>
      )}
    </div>
  )
}
