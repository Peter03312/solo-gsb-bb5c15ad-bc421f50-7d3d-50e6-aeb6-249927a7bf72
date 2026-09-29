import { useMemo, useState } from 'react'
import {
  buildMigrationPlan,
  migrationPlanText,
  MIGRATION_STEP_LABEL,
  type MigrationStep,
  type MigrationStepKind,
} from '../lib/migration'
import { intToIp } from '../lib/ip'
import PlanPauseNote from './PlanPauseNote'
import type { LeaseImportResult } from '../lib/leaseImport'
import type { HostAssignment, PlanResult } from '../lib/types'

interface Props {
  result: PlanResult
  assignments: HostAssignment[]
  /** 静态租约批量导入的当前合并预览（App 层与导入面板共享同一份计算结果） */
  imported: LeaseImportResult | null
  planning?: boolean
  planError?: string | null
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

const STEP_BADGE: Record<MigrationStepKind, string> = {
  'temp-move': 'migration-step temp-move',
  move: 'migration-step move',
  'cycle-complete': 'migration-step cycle-complete',
  add: 'migration-step add',
}

function IpCell({ value, muted }: { value?: number; muted?: boolean }) {
  if (value === undefined) return <span className="host-mac-none">—</span>
  return <span className={muted ? 'migration-temp-ip mono' : 'mono'}>{intToIp(value)}</span>
}

function StepRow({ step }: { step: MigrationStep }) {
  return (
    <tr className={`migration-row migration-row-${step.kind}`}>
      <td className="mono migration-order">{step.order}</td>
      <td>
        <span className={STEP_BADGE[step.kind]}>{MIGRATION_STEP_LABEL[step.kind]}</span>
      </td>
      <td className="host-device-name">{step.name}</td>
      <td className="mono host-addr">
        <IpCell value={step.fromAddress} />
      </td>
      <td className="mono host-addr">
        <strong>{intToIp(step.address)}</strong>
      </td>
      <td className="mono host-addr">
        <IpCell value={step.tempAddress} muted />
      </td>
      <td className="mono migration-cidr">{step.targetCidr}</td>
      <td className="host-reason migration-reason">{step.reason}</td>
    </tr>
  )
}

/**
 * 迁移执行编排面板（⑪）：
 * 复用「⑩ 静态租约批量导入」的登记现状与无冲突 CSV 合并预览，
 * 生成按序执行时不会产生瞬时重复 IPv4 的逐步改址清单。
 * 纯只读：不应用、不改登记；CSV / 规划 / 登记变化后实时重算。
 */
export default function MigrationPanel({
  result,
  assignments,
  imported,
  planning = false,
  planError = null,
}: Props) {
  const [copied, setCopied] = useState(false)

  const planPaused = planning || planError !== null
  const invalid = !planPaused && result.inputErrors.length > 0

  // CSV、规划、既有登记任意变化都立即重算（与导入面板共享同一个 imported 快照）；暂停期间不生成步骤
  const plan = useMemo(
    () => (!planPaused && !invalid && imported ? buildMigrationPlan(imported, assignments, result) : null),
    [planPaused, invalid, imported, assignments, result],
  )
  const text = useMemo(() => (plan?.ok ? migrationPlanText(plan) : ''), [plan])

  async function handleCopy() {
    if (!text) return
    const ok = await copyText(text)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }

  const hasCsvData =
    !!imported && !imported.syntaxError && imported.rows.length > 0 && imported.headerErrors.length === 0
  return (
    <div className="panel migration-panel">
      <h2>⑪ 迁移执行编排</h2>
      <p className="subtitle" style={{ marginBottom: 10 }}>
        复用上方<strong>现有主机登记</strong>与<strong>无冲突的 CSV 合并预览</strong>，以旧地址占用关系建立依赖图，
        生成按序执行时<strong>不会产生瞬时重复 IPv4</strong> 的逐步改址清单。无环依赖按可执行顺序输出；
        多个<strong>互换或多设备环路</strong>按环内最小旧地址升序<strong>逐环</strong>处理——每环先把一台设备迁到其
        <strong>原网段内选址当时最低的临时可用地址</strong>（避开当时占用与全部最终目标），环内改址、锚点归位后
        <strong>临时地址立即释放、供后续独立环复用</strong>；只有选址当时确实没有任何临时地址（或目标被不会迁走的设备占住）时，
        才<strong>阻断整份清单且不输出任何部分步骤</strong>。本模块<strong>只读、不改动登记</strong>；CSV 存在冲突时不产生结果。
      </p>

      {planPaused && (
        <PlanPauseNote
          planning={planning}
          planError={planError}
          planningText="迁移执行编排已暂停，原始 CSV 与登记均已保留。"
        />
      )}

      {!planPaused && invalid && (
        <div className="summary-disabled-note">
          输入非法（请先修正左侧错误），迁移执行编排已暂停；原始 CSV 与登记均已保留，修正后自动重算。
        </div>
      )}

      {!planPaused && !invalid && imported && imported.syntaxError && (
        <div className="summary-disabled-note">
          CSV 存在语法错误（第 {imported.syntaxError.line} 行第 {imported.syntaxError.column} 列，见上方 ⑩ 面板），
          迁移编排暂不产生结果、登记保持不变；修正后自动重算。
        </div>
      )}

      {!planPaused && !invalid && imported && imported.headerErrors.length > 0 && (
        <div className="summary-disabled-note">
          CSV 表头无法识别（见上方 ⑩ 面板），迁移编排暂不产生结果；修正表头后自动重算。
        </div>
      )}

      {!planPaused && !invalid && hasCsvData && imported.hasConflicts && (
        <div className="opt121-error-box">
          <strong>CSV 合并预览存在冲突：</strong>
          迁移编排<strong>不生成任何步骤、也不改动登记</strong>。请先在上方 ⑩ 面板修正全部标红冲突行，
          预览通过后这里会自动生成逐步改址清单。
        </div>
      )}

      {!planPaused && !invalid && hasCsvData && !imported.hasConflicts && plan && (
        <>
          {plan.blockers.length > 0 ? (
            <div className="opt121-error-box migration-block-box">
              <strong>迁移清单已被阻止（{plan.blockers.length} 项）：</strong>
              <ul>
                {plan.blockers.map((b, i) => (
                  <li key={i}>{b.message}</li>
                ))}
              </ul>
              <div className="migration-block-hint">
                未输出任何执行步骤，登记状态保持不变。请按提示释放地址 / 调整 CSV 后自动重算。
              </div>
            </div>
          ) : (
            <div className="lease-summary-row migration-summary-row">
              <span className="rdns-chip">
                改址设备 <strong>{plan.counts.moves}</strong>
              </span>
              <span className="rdns-chip lease-chip-add">
                新增上线 <strong>{plan.counts.adds}</strong>
              </span>
              <span className={`rdns-chip${plan.counts.cycles > 0 ? ' lease-chip-update' : ''}`}>
                地址环路 <strong>{plan.counts.cycles}</strong>
              </span>
              <span className="rdns-chip">
                临时迁出 <strong>{plan.counts.tempMoves}</strong>
              </span>
              <span className="rdns-chip">
                总步数 <strong>{plan.steps.length}</strong>
              </span>
              <button className="primary" onClick={handleCopy} disabled={plan.steps.length === 0} title="复制逐步改址清单（制表符分隔，可直接粘贴到表格 / 工单）">
                {copied ? '✓ 已复制' : '📋 复制清单'}
              </button>
            </div>
          )}

          {plan.cycles.length > 0 && (
            <div className="migration-cycles">
              <h4>地址依赖环（{plan.cycles.length}）</h4>
              <ul className="migration-cycle-list">
                {plan.cycles.map((c, i) => (
                  <li key={i} className={c.blocked ? 'is-blocked' : ''}>
                    环 {i + 1}（按环内最小旧地址升序）：
                    {c.deviceNames.map((n) => `“${n}”`).join(' → ')} → 回到起点：
                    {c.blocked ? (
                      <span className="lease-blocked-hint">
                        {' '}
                        已阻止（{c.blockReason}）
                      </span>
                    ) : (
                      <>
                        {' '}以设备<strong>“{c.pivotName}”</strong>为临时锚点，先迁至原网段{' '}
                        <code className="mono">{c.tempCidr}</code> 的临时地址{' '}
                        <code className="mono migration-temp-ip">{intToIp(c.tempAddress!)}</code>
                        ，环内改址完成后锚点归位、该临时地址释放（可被后续环复用）
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.ok && plan.steps.length > 0 && (
            <div className="table-scroll">
              <table className="host-table migration-table">
                <thead>
                  <tr>
                    <th className="migration-order">步</th>
                    <th>操作</th>
                    <th className="host-device-name">设备</th>
                    <th className="host-addr">原地址</th>
                    <th className="host-addr">目标地址</th>
                    <th className="host-addr">临时地址</th>
                    <th>目标网段</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.steps.map((step) => (
                    <StepRow key={`${step.order}-${step.deviceId}`} step={step} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {plan.ok && plan.changedDevices === 0 && (
            <div className="dnsmasq-empty">
              当前登记与 CSV 合并预览完全一致（全部为「无变化」行）：没有需要迁移的设备。
            </div>
          )}
        </>
      )}

      {!planPaused && !invalid && !hasCsvData && (
        <p className="summary-empty">
          尚未粘贴有效的 CSV 数据。请在上方 ⑩ 静态租约批量导入中粘贴含表头的 CSV；预览无冲突后，
          这里会自动给出从现有登记到合并结果的逐步改址清单（含设备、原 / 目标 / 临时地址与每步原因）。
        </p>
      )}
    </div>
  )
}
