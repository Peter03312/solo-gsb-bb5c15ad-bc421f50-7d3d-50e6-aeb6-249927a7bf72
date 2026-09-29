/// <reference lib="webworker" />
import { plan } from '../lib/planner'
import type { PlannerFailure, PlannerRequest, PlannerResponse } from '../lib/plannerProtocol'

/**
 * 规划 Worker：在后台线程执行与主线程完全相同的 plan() 分配算法，
 * 结果结构（PlanResult）不变。每条请求携带递增版本号，回包原样带回；
 * 过期任务由主线程在提交新快照时通过 terminate 终止，过期回包也会被主线程丢弃。
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (e: MessageEvent<PlannerRequest>) => {
  const { version, input } = e.data
  try {
    const result = plan(input)
    const response: PlannerResponse = { version, result }
    ctx.postMessage(response)
  } catch (err) {
    const failure: PlannerFailure = {
      version,
      message: err instanceof Error ? err.message : String(err),
    }
    ctx.postMessage(failure)
  }
}
