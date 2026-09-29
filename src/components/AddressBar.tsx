import type { Segment } from '../lib/types'

interface Props {
  segments: Segment[]
  totalCapacity: number
  selectedIndex: number | null
  onSelect: (index: number) => void
}

const LABEL: Record<Segment['kind'], string> = {
  reserved: '保留',
  fixed: '固定',
  auto: '自动',
  free: '空闲',
}

export default function AddressBar({ segments, totalCapacity, selectedIndex, onSelect }: Props) {
  if (segments.length === 0 || totalCapacity <= 0) return null

  return (
    <div className="bar-wrap">
      <div className="bar" role="list" aria-label="地址分配比例条">
        {segments.map((seg, i) => {
          const widthPct = (seg.capacity / totalCapacity) * 100
          const title = `${LABEL[seg.kind]} · ${seg.name} · ${seg.cidr} · ${seg.capacity} 地址`
          return (
            <div
              key={i}
              role="listitem"
              className={`bar-seg ${seg.kind}${selectedIndex === i ? ' selected' : ''}`}
              style={{ flexGrow: seg.capacity, flexBasis: `${Math.max(widthPct, 0.15)}%` }}
              title={title}
              onClick={() => onSelect(i)}
            />
          )
        })}
      </div>
      <div className="legend">
        <span>
          <span className="dot" style={{ background: 'var(--reserved)' }} />
          保留
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--fixed)' }} />
          固定
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--auto)' }} />
          自动
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--free)' }} />
          空闲
        </span>
        <span>提示：点击色块或下方表格行查看明细</span>
      </div>
    </div>
  )
}
