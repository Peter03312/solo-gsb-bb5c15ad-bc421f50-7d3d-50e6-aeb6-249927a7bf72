import type { PlanResult, ReflowReport, ReflowStatus } from '../lib/types'

const STATUS_META: Record<ReflowStatus, { label: string; cls: string; hint: string }> = {
  kept: { label: '保留原址', cls: 'reflow-kept', hint: '优先候选可行，网段留在基线原址' },
  moved: { label: '原址迁移', cls: 'reflow-moved', hint: '优先候选可行，但新前缀的对齐块起点已离开基线原址' },
  'fallback-kept': {
    label: '兜底保留',
    cls: 'reflow-kept',
    hint: '优先候选不可行，最低对齐策略恰好落在基线原址',
  },
  'fallback-moved': {
    label: '兜底迁移',
    cls: 'reflow-moved',
    hint: '优先候选不可行，由最低对齐策略迁移到新地址',
  },
  failed: { label: '无法分配', cls: 'reflow-failed', hint: '优先候选与最低对齐策略都无法容纳该需求' },
  'fixed-untouched': { label: '固定段', cls: 'reflow-skip', hint: '基线固定需求且当前仍是固定网段，不参与重排' },
  'became-fixed': { label: '转为固定', cls: 'reflow-skip', hint: '当前为用户指定的固定网段，位置不参与重排' },
  'baseline-fixed': { label: '固定转自动', cls: 'reflow-skip', hint: '基线时为固定网段、当前改为自动，无自动原址可保留' },
  'baseline-failed': { label: '基线时未分配', cls: 'reflow-skip', hint: '基线时本就未分配，无原址可保留' },
  new: { label: '新增需求', cls: 'reflow-new', hint: '基线保存后新增，直接按最低对齐策略分配' },
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className="stat">
      <div className="v" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      <div className="k">{label}</div>
    </div>
  )
}

/** 结果区顶部的紧凑重排统计横幅 */
export function ReflowSummaryBar({ report }: { report: ReflowReport }) {
  const c = report.counts
  return (
    <div className="panel reflow-banner">
      <div className="header-row">
        <h2 style={{ marginBottom: 0 }}>基线优先重排结果</h2>
        <span className="baseline-meta">
          优先候选采纳 {report.anchorsAccepted} · 被拒 {report.anchorsRejected}
        </span>
      </div>
      <div className="stat-grid diff-stats">
        <Stat value={c.kept} label="保留原址" tone="var(--auto)" />
        <Stat value={c.moved} label="原址块内迁移" tone="var(--diff-still)" />
        <Stat value={c.fallbackKept + c.fallbackMoved} label="改走最低对齐" tone="#7dd3fc" />
        <Stat value={c.failed} label="无法分配" tone={c.failed > 0 ? '#fca5a5' : undefined} />
        <Stat value={c.new} label="新增需求" tone="#6ee7b7" />
        <Stat value={c.skipped} label="不参与重排" tone="var(--muted)" />
      </div>
    </div>
  )
}

function RowStatus({ status }: { status: ReflowStatus }) {
  const meta = STATUS_META[status]
  return (
    <span className={`change-badge ${meta.cls}`} title={meta.hint}>
      {meta.label}
    </span>
  )
}

/** BaselinePanel 内的完整重排明细报告 */
export default function ReflowReportPanel({ result }: { result: PlanResult }) {
  const report = result.reflow
  if (!report) return null

  return (
    <div className="reflow-report">
      <h3 className="table-heading">
        基线优先重排明细（共 {report.rows.length} 项）
        <span className="baseline-meta">
          包含原网络地址的对齐块为优先候选；越界 / 撞保留区或固定段 / 候选冲突时按规模从大到小、
          同规模按录入顺序保留可行候选，其余走最低对齐策略
        </span>
      </h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>结果</th>
              <th>名称</th>
              <th style={{ textAlign: 'right' }}>需求主机</th>
              <th>基线网段</th>
              <th>优先候选</th>
              <th>当前网段</th>
              <th>说明 / 无法分配原因</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => {
              const meta = STATUS_META[row.status]
              return (
                <tr key={row.id} className={`reflow-row ${meta.cls}`}>
                  <td>
                    <RowStatus status={row.status} />
                  </td>
                  <td>{row.name}</td>
                  <td style={{ textAlign: 'right' }} className="mono">
                    {row.hosts}
                  </td>
                  <td className="mono">{row.baselineCidr ?? '—'}</td>
                  <td className="mono">
                    {row.candidate ? (
                      <span title={row.candidate.accepted ? '已采纳' : row.candidate.reason}>
                        {row.candidate.cidr}
                        {!row.candidate.accepted && <span className="candidate-rejected"> ✗</span>}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="mono">{row.currentCidr ?? '—'}</td>
                  <td className="change-note">
                    {row.status === 'failed'
                      ? row.reason
                      : row.candidate && !row.candidate.accepted
                        ? `候选未采纳：${row.candidate.reason}；${meta.hint}`
                        : meta.hint}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
