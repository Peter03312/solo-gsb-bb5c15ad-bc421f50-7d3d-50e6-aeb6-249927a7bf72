import type { ChangeRow, ChangeType, Segment } from '../lib/types'

interface Props {
  segments: Segment[]
  selectedIndex: number | null
  onSelect: (index: number) => void
  /** 基线对比开启时，各需求 ID 对应的变化（仅当前仍有网段的项会显示标记） */
  changesById?: Map<string, ChangeRow>
  /** 基线优先重排模式开启时，展示各自动网段相对基线原址的结果 */
  showReflow?: boolean
}

const KIND_LABEL: Record<Segment['kind'], string> = {
  reserved: '保留',
  fixed: '固定',
  auto: '自动',
  free: '空闲',
}

const REFLOW_LABEL: Record<NonNullable<Segment['baselineOutcome']>, string> = {
  kept: '保留原址',
  moved: '迁移',
}

const REFLOW_CLS: Record<NonNullable<Segment['baselineOutcome']>, string> = {
  kept: 'reflow-kept',
  moved: 'reflow-moved',
}

const CHANGE_LABEL: Partial<Record<ChangeType, string>> = {
  added: '新增',
  migrated: '迁移',
  resized: '容量变化',
  recovered: '恢复分配',
  unchanged: '未变',
}

const CHANGE_CLS: Partial<Record<ChangeType, string>> = {
  added: 'added',
  migrated: 'migrated',
  resized: 'resized',
  recovered: 'recovered',
  unchanged: 'unchanged',
}

export default function SegmentTable({ segments, selectedIndex, onSelect, changesById, showReflow }: Props) {
  const showBaseline = changesById !== undefined
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>类型</th>
            <th>名称</th>
            <th>网段 / 区间</th>
            <th>网络地址</th>
            <th>广播地址</th>
            <th>可用范围</th>
            <th style={{ textAlign: 'right' }}>容量</th>
            <th style={{ textAlign: 'right' }}>可用主机</th>
            <th style={{ textAlign: 'right' }}>需求主机</th>
            <th style={{ textAlign: 'right' }}>浪费</th>
            {showBaseline && <th>基线对比</th>}
            {showReflow && <th>基线重排</th>}
          </tr>
        </thead>
        <tbody>
          {segments.map((seg, i) => {
            const change = showBaseline && seg.ownerId ? changesById!.get(seg.ownerId) : undefined
            return (
              <tr
                key={i}
                className={`clickable${selectedIndex === i ? ' selected' : ''}${
                  change ? ` row-${CHANGE_CLS[change.type] ?? ''}` : ''
                }`}
                onClick={() => onSelect(i)}
              >
                <td className="mono">{i + 1}</td>
                <td>
                  <span className={`badge ${seg.kind}`}>{KIND_LABEL[seg.kind]}</span>
                </td>
                <td>{seg.name}</td>
                <td className="mono">{seg.cidr}</td>
                <td className="mono">{seg.network}</td>
                <td className="mono">{seg.broadcast}</td>
                <td className="mono">
                  {seg.firstUsable === '—' ? '—' : `${seg.firstUsable} ~ ${seg.lastUsable}`}
                </td>
                <td style={{ textAlign: 'right' }} className="mono">
                  {seg.capacity}
                </td>
                <td style={{ textAlign: 'right' }} className="mono">
                  {seg.usable}
                </td>
                <td style={{ textAlign: 'right' }} className="mono">
                  {seg.requestedHosts ?? '—'}
                </td>
                <td style={{ textAlign: 'right' }} className="mono">
                  {seg.kind === 'reserved' || seg.kind === 'free' ? '—' : seg.waste}
                </td>
                {showBaseline && (
                  <td>
                    {change && CHANGE_LABEL[change.type] ? (
                      <span className={`change-badge ${CHANGE_CLS[change.type]}`}>
                        {change.type === 'resized'
                          ? change.resize === 'grow'
                            ? '扩容'
                            : '缩容'
                          : CHANGE_LABEL[change.type]}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                )}
                {showReflow && (
                  <td>
                    {seg.kind === 'auto' && seg.baselineOutcome ? (
                      <span
                        className={`change-badge ${REFLOW_CLS[seg.baselineOutcome]}`}
                        title={
                          seg.baselineAnchored
                            ? '经包含原网络地址的对齐块优先落位'
                            : '优先候选不可行，由最低对齐策略落位'
                        }
                      >
                        {REFLOW_LABEL[seg.baselineOutcome]}
                        {!seg.baselineAnchored ? '（最低对齐）' : ''}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
