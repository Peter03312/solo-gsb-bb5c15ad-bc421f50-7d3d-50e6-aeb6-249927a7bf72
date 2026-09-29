import { useMemo, useState } from 'react'
import {
  buildLeaseImport,
  LEASE_IMPORT_SAMPLE,
  LEASE_STATUS_LABEL,
  type LeaseImportRow,
  type LeaseImportResult,
  type LeaseImportStatus,
} from '../lib/leaseImport'
import { intToIp } from '../lib/ip'
import PlanPauseNote from './PlanPauseNote'
import type { HostAssignment, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
  csv: string
  onCsvChange: (next: string) => void
  onAssignmentsChange: (next: HostAssignment[]) => void
  /** App 层统一计算的合并预览（与迁移编排面板共享同一份结果）；缺省时由本面板自行计算 */
  built?: LeaseImportResult | null
  planning?: boolean
  planError?: string | null
}

const KIND_LABEL = { fixed: '固定', auto: '自动' } as const

const STATUS_BADGE: Record<LeaseImportStatus, string> = {
  add: 'lease-status add',
  update: 'lease-status update',
  unchanged: 'lease-status unchanged',
  conflict: 'lease-status conflict',
}

/** 行内「原值 → 新值」的更新摘要（命中既有 MAC 时展示） */
function diffSummary(row: LeaseImportRow): string | null {
  if (row.status !== 'update' || !row.existing || !row.segment) return null
  const parts: string[] = []
  const oldIp = intToIp(row.existing.address)
  if (row.existing.ownerId !== row.segment.ownerId) parts.push(`网段迁移；地址 ${oldIp} → ${row.ip}`)
  else if (oldIp !== row.ip) parts.push(`地址 ${oldIp} → ${row.ip}`)
  if (row.existing.name !== row.name) parts.push(`改名“${row.existing.name || '未命名'}”→“${row.name}”`)
  return parts.length > 0 ? parts.join('；') : null
}

/** 静态租约批量导入面板：粘贴含表头 CSV → 实时预览 → 全部通过后一次性替换登记状态 */
export default function LeaseImportPanel({
  result,
  assignments,
  csv,
  onCsvChange,
  onAssignmentsChange,
  built: builtProp,
  planning = false,
  planError = null,
}: Props) {
  const [appliedNote, setAppliedNote] = useState<string | null>(null)

  const planPaused = planning || planError !== null
  const invalid = !planPaused && result.inputErrors.length > 0

  // CSV 文本、规划或既有登记任意变化都实时重算预览；原始 CSV 始终原样保留。
  // 规划暂停（计算中 / Worker 异常）时由 App 层传入 null，本面板也不自行回退计算。
  const builtFallback = useMemo(
    () => (invalid || planPaused || builtProp !== undefined ? null : buildLeaseImport(csv, assignments, result)),
    [csv, assignments, result, invalid, planPaused, builtProp],
  )
  const built = planPaused ? null : (builtProp ?? builtFallback)

  function handleApply() {
    if (planPaused || !built || !built.canApply) return
    // 全部通过后一次性替换状态（原子应用，避免逐行处理造成的顺序性误报）
    onAssignmentsChange(built.merged)
    setAppliedNote(
      `已应用：新增 ${built.addCount} 台、更新 ${built.updateCount} 台${
        built.counts.unchanged > 0 ? `、无变化 ${built.counts.unchanged} 台` : ''
      }。当前共 ${built.merged.length} 台登记。`,
    )
  }

  function handleClearCsv() {
    onCsvChange('')
    setAppliedNote(null)
  }

  const hasCsv = csv.trim() !== ''
  const counts = built?.counts

  return (
    <div className="panel lease-import-panel">
      <h2>⑩ 静态租约批量导入</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        粘贴<strong>含表头</strong>的 CSV（列为「<strong>网段 CIDR、设备名、IPv4、MAC</strong>」，顺序不限、支持常见别名），
        按当前成功分配的<strong>固定 / 自动网段</strong>实时生成预览。MAC 规范化（小写冒号）后作为设备身份：
        <strong>已有 MAC 更新名称、网段与地址，新 MAC 新增</strong>。应用前会构造「现有登记 + 本次导入」的
        <strong>合并快照统一校验</strong>（故两台已有设备互换地址不会误报），逐行标记
        <span className="lease-status add"> 新增 </span>
        <span className="lease-status update"> 更新 </span>
        <span className="lease-status unchanged"> 无变化 </span>
        <span className="lease-status conflict"> 冲突 </span>
        。<strong>任一冲突即禁止应用</strong>，全部通过后一次性替换登记状态。引号语法严格校验
        （引号仅在字段首位、闭引号后仅允许逗号 / 换行），<strong>首个语法错误按物理行、列定位并整批拒绝</strong>。
        <strong>只有完全空白（无逗号、无引号）的物理行才会被忽略</strong>；像 <code className="mono">,,,</code>、<code className="mono">""</code>
        这样含分隔符或引号空字段的行仍是数据行，会保留原物理行号并逐字段提示缺失、同样阻止整批应用。
        规划变化后原始 CSV 保留、预览自动重算。
      </p>

      {planPaused && (
        <PlanPauseNote
          planning={planning}
          planError={planError}
          planningText="租约导入预览与应用已暂停，原始 CSV 已保留且仍可编辑。"
        />
      )}
      {invalid && (
        <div className="summary-disabled-note">
          输入非法（请先修正左侧错误），静态租约批量导入已暂停；原始 CSV 已保留，修正后预览自动恢复。
        </div>
      )}

      <div className="btn-row lease-toolbar">
        <button onClick={() => onCsvChange(LEASE_IMPORT_SAMPLE)} disabled={invalid}>
          填入示例 CSV
        </button>
        <button onClick={handleClearCsv} disabled={!hasCsv}>
          清空 CSV
        </button>
        <span className="opt121-toolbar-hint">
          表头示例：<code className="mono">网段 CIDR,设备名,IPv4,MAC</code>；CIDR 必须与当前规划网段完全一致
        </span>
      </div>

      <textarea
        className="lease-textarea mono"
        spellCheck={false}
        rows={8}
        placeholder={'网段 CIDR,设备名,IPv4,MAC\n192.168.10.16/30,网关,192.168.10.17,aa:bb:cc:dd:ee:ff'}
        value={csv}
        disabled={invalid}
        onChange={(e) => {
          onCsvChange(e.target.value)
          setAppliedNote(null)
        }}
      />

      {!planPaused && built && built.syntaxError && (
        <div className="opt121-error-box">
          <strong>
            CSV 语法错误（第 {built.syntaxError.line} 行第 {built.syntaxError.column} 列）：
          </strong>
          <ul>
            {built.syntaxErrors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          <div className="migration-block-hint">
            存在语法错误时整批不可应用、既有登记保持不变、迁移编排停止生成；修正后预览自动恢复，原始 CSV 不会丢失。
          </div>
        </div>
      )}

      {!planPaused && built && built.headerErrors.length > 0 && (
        <div className="opt121-error-box">
          <strong>无法识别 CSV 表头：</strong>
          <ul>
            {built.headerErrors.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {!planPaused && built && built.rows.length > 0 && (
        <>
          <div className="lease-summary-row">
            <span className="rdns-chip">
              数据行 <strong>{counts!.rows}</strong>
            </span>
            <span className="rdns-chip lease-chip-add">
              新增 <strong>{counts!.add}</strong>
            </span>
            <span className="rdns-chip lease-chip-update">
              更新 <strong>{counts!.update}</strong>
            </span>
            <span className="rdns-chip">
              无变化 <strong>{counts!.unchanged}</strong>
            </span>
            <span className={`rdns-chip${counts!.conflict > 0 ? ' is-zero' : ''}`}>
              冲突 <strong>{counts!.conflict}</strong>
            </span>
            <button className="primary" onClick={handleApply} disabled={!built.canApply} title="全部通过后一次性替换主机登记状态">
              ✓ 应用导入（{built.addCount + built.updateCount} 台变更）
            </button>
            {built.hasConflicts && (
              <span className="lease-blocked-hint">存在冲突，已禁止应用；请修正标红行后预览会自动刷新。</span>
            )}
          </div>

          <div className="table-scroll">
            <table className="host-table lease-preview-table">
              <thead>
                <tr>
                  <th className="lease-idx">#</th>
                  <th>状态</th>
                  <th>网段 CIDR</th>
                  <th className="host-device-name">设备名</th>
                  <th className="host-addr">IPv4</th>
                  <th className="host-mac-head">MAC</th>
                  <th>校验结果 / 变更</th>
                </tr>
              </thead>
              <tbody>
                {built.rows.map((row) => (
                  <tr key={row.line} className={row.status === 'conflict' ? 'lease-row-conflict' : ''}>
                    <td className="mono lease-idx">{row.index}</td>
                    <td>
                      <span className={STATUS_BADGE[row.status]}>{LEASE_STATUS_LABEL[row.status]}</span>
                    </td>
                    <td className="mono lease-cidr-cell">
                      {row.segment ? (
                        <>
                          <span className={`badge ${row.segment.kind}`}>{KIND_LABEL[row.segment.kind]}</span>{' '}
                          {row.cidr}
                        </>
                      ) : (
                        <span className={row.rawCidr ? 'host-addr-bad' : 'host-mac-none'}>
                          {row.rawCidr || '— 缺失 —'}
                        </span>
                      )}
                    </td>
                    <td className="host-device-name">{row.name ?? <span className="host-addr-bad">{row.rawName || '— 缺失 —'}</span>}</td>
                    <td className="mono host-addr">
                      {row.ip !== undefined ? (
                        row.status === 'conflict' && /网络地址|广播地址|越界|不在网段|重复/.test(row.errors.join(' ')) ? (
                          <span className="host-addr-bad">{row.ip}</span>
                        ) : (
                          row.ip
                        )
                      ) : (
                        <span className="host-addr-bad">{row.rawIp || '— 缺失 —'}</span>
                      )}
                    </td>
                    <td className="mono host-mac-cell">
                      {row.mac ?? <span className="host-addr-bad">{row.rawMac || '— 缺失 —'}</span>}
                    </td>
                    <td className="host-reason">
                      {row.errors.length > 0 ? (
                        <ul className="lease-row-errors">
                          {row.errors.map((m, i) => (
                            <li key={i}>{m}</li>
                          ))}
                        </ul>
                      ) : (
                        (diffSummary(row) ?? (row.status === 'add' ? '新 MAC，作为新设备追加' : '与既有登记一致'))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!planPaused && built && !built.syntaxError && built.headerErrors.length === 0 && built.rows.length === 0 && hasCsv && (
        <div className="dnsmasq-empty">CSV 只有表头、没有数据行；粘贴数据后这里将实时显示逐行预览。</div>
      )}

      {!planPaused && !hasCsv && !invalid && (
        <p className="summary-empty">
          尚未粘贴 CSV。可点击「填入示例 CSV」参考格式；支持引号包裹的字段（字段内可含逗号与换行），
          引号必须出现在字段首位、闭引号后只允许逗号或换行；完全空白的物理行会被忽略，
          但含逗号（如 <code className="mono">,,,</code>）或引号空字段（如 <code className="mono">""</code>）的行仍是数据行并逐字段报缺失。
          导入只更新主机登记，不影响规划、基线、路由汇总与 JSON 导出。
        </p>
      )}

      {appliedNote && <div className="lease-applied-note">✓ {appliedNote}</div>}
    </div>
  )
}
