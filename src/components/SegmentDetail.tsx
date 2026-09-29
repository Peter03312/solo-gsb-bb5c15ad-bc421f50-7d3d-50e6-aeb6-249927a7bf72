import type { Segment } from '../lib/types'

const META: Record<Segment['kind'], { label: string; cls: string }> = {
  reserved: { label: '保留', cls: 'reserved' },
  fixed: { label: '固定', cls: 'fixed' },
  auto: { label: '自动', cls: 'auto' },
  free: { label: '空闲', cls: 'free' },
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="k">{k}：</span>
      <span className="mono">{children}</span>
    </div>
  )
}

export default function SegmentDetail({ segment }: { segment: Segment }) {
  const meta = META[segment.kind]
  return (
    <div className="detail-card">
      <div className="title">
        {segment.name}
        <span className={`badge ${meta.cls}`}>{meta.label}</span>
      </div>
      <div className="detail-grid">
        <Row k="网段 / 区间">{segment.cidr}</Row>
        <Row k="网络地址">{segment.network}</Row>
        <Row k="广播地址">{segment.broadcast}</Row>
        <Row k="可用范围">
          {segment.firstUsable === '—' ? '—（无标准可用主机地址）' : `${segment.firstUsable} ~ ${segment.lastUsable}`}
        </Row>
        <Row k="容量">{segment.capacity} 个地址</Row>
        <Row k="可用主机数">{segment.usable}</Row>
        {segment.kind !== 'free' && (
          <Row k="需求主机数">{segment.requestedHosts ?? '—'}</Row>
        )}
        {segment.kind === 'auto' || segment.kind === 'fixed' ? (
          <Row k="浪费量">{segment.waste} 个地址</Row>
        ) : segment.kind === 'reserved' ? (
          <Row k="浪费量">不参与需求分配</Row>
        ) : (
          <Row k="浪费量">未分配</Row>
        )}
        {segment.kind === 'auto' && segment.baselineOutcome && (
          <Row k="基线重排">
            {segment.baselineOutcome === 'kept' ? '保留原址' : '迁移'}
            {segment.baselineAnchored ? '（优先候选）' : '（最低对齐策略）'}
          </Row>
        )}
      </div>
    </div>
  )
}
