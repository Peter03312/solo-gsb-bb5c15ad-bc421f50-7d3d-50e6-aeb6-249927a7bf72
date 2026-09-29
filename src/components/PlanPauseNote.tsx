interface Props {
  /** 规划 Worker 正在计算新版本结果 */
  planning: boolean
  /** Worker 异常（App 顶部已展示错误详情，这里仅说明面板暂停） */
  planError: string | null
  /** 计算中说明（描述本面板暂停的动作与保留的数据，句中片段） */
  planningText: string
  /** 异常时说明（缺省复用 planningText） */
  errorText?: string
}

/**
 * 依赖规划结果的面板统一暂停条：
 * 新输入产生后（计算中）或 Worker 异常时暂停结果生成；录入始终保留，当前版本结果到达后自动恢复。
 */
export default function PlanPauseNote({ planning, planError, planningText, errorText }: Props) {
  if (planning) {
    return (
      <div className="summary-disabled-note plan-pause-note" role="status">
        <span className="plan-spinner plan-spinner-inline" aria-hidden="true" />
        规划正在后台重新计算：{planningText}输入与已有录入不会丢失，当前版本结果到达后自动恢复。
      </div>
    )
  }
  if (planError !== null) {
    return (
      <div className="summary-disabled-note plan-pause-note" role="alert">
        规划计算发生异常（错误详情见页面顶部）：{errorText ?? planningText}
        输入与已有录入均已保留，继续编辑即可自动重新计算。
      </div>
    )
  }
  return null
}
