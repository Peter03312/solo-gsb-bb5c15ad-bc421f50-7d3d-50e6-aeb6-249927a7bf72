import type { PlanResult, Segment } from './types'

function segmentForExport(s: Segment) {
  const base = {
    类型:
      s.kind === 'reserved'
        ? '保留'
        : s.kind === 'fixed'
          ? '固定'
          : s.kind === 'auto'
            ? '自动'
            : '空闲',
    名称: s.name,
    网段: s.cidr,
    网络地址: s.network,
    广播地址: s.broadcast,
    可用范围: s.firstUsable === '—' ? '—' : `${s.firstUsable} ~ ${s.lastUsable}`,
    容量: s.capacity,
    可用主机数: s.usable,
  }
  if (s.kind === 'free') return base
  const withNeed = {
    ...base,
    需求主机数: s.requestedHosts ?? null,
    浪费量: s.waste,
  }
  if (s.kind === 'auto' && s.baselineOutcome) {
    return {
      ...withNeed,
      基线重排:
        s.baselineOutcome === 'kept'
          ? s.baselineAnchored
            ? '保留原址（优先候选）'
            : '保留原址（最低对齐）'
          : s.baselineAnchored
            ? '迁移（优先候选对齐块）'
            : '迁移（最低对齐）',
    }
  }
  return withNeed
}

const REFLOW_STATUS_TEXT: Record<string, string> = {
  kept: '保留原址',
  moved: '原址块内迁移',
  'fallback-kept': '兜底保留原址',
  'fallback-moved': '兜底迁移',
  failed: '无法分配',
  'fixed-untouched': '固定段不参与重排',
  'became-fixed': '转为固定段',
  'baseline-fixed': '基线固定段转自动',
  'baseline-failed': '基线时未分配',
  new: '新增需求',
}

export function buildExportJson(result: PlanResult, input: { parentCidr: string }): string {
  const payload: Record<string, unknown> = {
    导出时间: new Date().toISOString(),
    父CIDR: result.parentCidr || input.parentCidr,
    父网络地址: result.parentNetwork,
    父前缀长度: result.parentPrefix === -1 ? null : result.parentPrefix,
    父网段容量: result.parentSize,
    统计: {
      保留地址数: result.summary.reserved,
      固定网段地址数: result.summary.fixed,
      自动网段地址数: result.summary.auto,
      空闲地址数: result.summary.free,
      已分配可用地址: result.summary.allocatedUsable,
      需求主机总数: result.summary.requestedHosts,
      浪费地址数: result.summary.waste,
      地址利用率: `${result.summary.utilization.toFixed(2)}%`,
    },
    网段: result.segments.map(segmentForExport),
    失败需求: result.failures.map((f) => ({
      名称: f.name,
      需求主机数: f.hosts,
      原因: f.reason,
    })),
  }
  if (result.reflow) {
    const c = result.reflow.counts
    payload['基线优先重排'] = {
      保留原址: c.kept,
      原址块内迁移: c.moved,
      兜底保留: c.fallbackKept,
      兜底迁移: c.fallbackMoved,
      无法分配: c.failed,
      新增需求: c.new,
      不参与重排: c.skipped,
      优先候选采纳数: result.reflow.anchorsAccepted,
      优先候选被拒数: result.reflow.anchorsRejected,
      明细: result.reflow.rows.map((row) => ({
        名称: row.name,
        结果: REFLOW_STATUS_TEXT[row.status] ?? row.status,
        需求主机数: row.hosts,
        基线网段: row.baselineCidr ?? null,
        优先候选: row.candidate
          ? { 网段: row.candidate.cidr, 是否采纳: row.candidate.accepted, 未采纳原因: row.candidate.reason ?? null }
          : null,
        当前网段: row.currentCidr ?? null,
        原因: row.reason ?? null,
      })),
    }
  }
  return JSON.stringify(payload, null, 2)
}

export function downloadJson(result: PlanResult, input: { parentCidr: string }) {
  const json = buildExportJson(result, input)
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  a.href = url
  a.download = `vlsm-plan-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
