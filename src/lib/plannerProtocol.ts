import type { PlanResult, PlannerInput } from './types'

/**
 * 空输入的规划结果：与 plan({ parentCidr: '', reservations: [], requirements: [] }) 完全一致。
 * Worker 尚未返回首个结果期间，界面使用该结构暂停全部依赖规划的面板（结果不可信时不展示）。
 */
export const EMPTY_PLAN_RESULT: PlanResult = {
  parentCidr: '',
  parentNetwork: '',
  parentPrefix: -1,
  parentSize: 0,
  segments: [],
  failures: [],
  inputErrors: ['请填写父 CIDR（例如 192.168.1.0/24）'],
  summary: {
    reserved: 0,
    fixed: 0,
    auto: 0,
    free: 0,
    totalCapacity: 0,
    usedCapacity: 0,
    allocatedUsable: 0,
    requestedHosts: 0,
    waste: 0,
    utilization: 0,
  },
}

/** 提交给规划 Worker 的输入快照（带递增版本） */
export interface PlannerRequest {
  version: number
  input: PlannerInput
}

/** Worker 回传的完整规划结果（仅当前版本可被发布） */
export interface PlannerResponse {
  version: number
  result: PlanResult
}

/** Worker 计算异常（输入原样保留，下次编辑会重新提交） */
export interface PlannerFailure {
  version: number
  message: string
}
