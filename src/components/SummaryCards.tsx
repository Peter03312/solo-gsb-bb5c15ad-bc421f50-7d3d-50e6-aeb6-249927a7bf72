import type { PlanResult } from '../lib/types'

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

export default function SummaryCards({ result }: { result: PlanResult }) {
  const s = result.summary
  return (
    <div className="stat-grid">
      <div className="stat">
        <div className="v">{fmt(s.totalCapacity)}</div>
        <div className="k">父网段总地址</div>
      </div>
      <div className="stat">
        <div className="v" style={{ color: 'var(--reserved)' }}>
          {fmt(s.reserved)}
        </div>
        <div className="k">保留地址</div>
      </div>
      <div className="stat">
        <div className="v" style={{ color: 'var(--fixed)' }}>
          {fmt(s.fixed)}
        </div>
        <div className="k">固定网段地址</div>
      </div>
      <div className="stat">
        <div className="v" style={{ color: 'var(--auto)' }}>
          {fmt(s.auto)}
        </div>
        <div className="k">自动网段地址</div>
      </div>
      <div className="stat">
        <div className="v" style={{ color: 'var(--muted)' }}>
          {fmt(s.free)}
        </div>
        <div className="k">空闲地址</div>
      </div>
      <div className="stat">
        <div className="v">{s.utilization.toFixed(1)}%</div>
        <div className="k">地址利用率</div>
      </div>
      <div className="stat">
        <div className="v">{fmt(s.allocatedUsable)}</div>
        <div className="k">已规划可用主机位</div>
      </div>
      <div className="stat">
        <div className="v">{fmt(s.requestedHosts)}</div>
        <div className="k">需求主机总数</div>
      </div>
      <div className="stat">
        <div className="v" style={{ color: s.waste > 0 ? '#fcd34d' : undefined }}>
          {fmt(s.waste)}
        </div>
        <div className="k">自动/固定网段浪费量</div>
      </div>
    </div>
  )
}
