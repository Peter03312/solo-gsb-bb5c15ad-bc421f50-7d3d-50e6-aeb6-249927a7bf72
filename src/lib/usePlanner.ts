import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  EMPTY_PLAN_RESULT,
  type PlannerFailure,
  type PlannerRequest,
  type PlannerResponse,
} from './plannerProtocol'
import type { PlanResult, PlannerInput } from './types'

export type { PlannerFailure }

export type PlannerStatus = 'computing' | 'ready' | 'error'

export interface PlannerState {
  /** 最近一次成功的完整结果（计算期间保留旧结果，但依赖面板会被统一暂停，不展示旧结果） */
  result: PlanResult
  status: PlannerStatus
  /** Worker 异常信息（计算异常时存在；输入与录入均保留，下次编辑自动重算） */
  error: string | null
  /** 当前递增版本（与输入快照一一对应） */
  version: number
}

/**
 * 规划计算钩子：把父网段 / 保留区 / 需求 / 基线（重排开关）的输入快照提交给 Web Worker。
 *
 * - 输入变化时在渲染后、浏览器绘制前立即进入 computing（依赖面板即刻暂停，无一帧旧结果闪现）；
 * - 每次提交都终止旧 Worker（被替代的任务同步中止）并以新版本号重发快照；
 * - 只有与当前版本号一致的完整结果才会被发布，过期消息一律丢弃；
 * - Worker 异常显示错误且保留输入，下一次编辑提交新版本即可恢复；
 * - 清空输入与组件卸载都会终止任务。
 */
export function usePlanner(input: PlannerInput): PlannerState {
  const [state, setState] = useState<PlannerState>({
    result: EMPTY_PLAN_RESULT,
    status: 'computing',
    error: null,
    version: 0,
  })
  const versionRef = useRef(0)
  const workerRef = useRef<Worker | null>(null)

  // 在绘制前提交：新版本立即暂停所有依赖面板（旧结果不再作为当前结果发布/用于生成）
  useLayoutEffect(() => {
    versionRef.current += 1
    const version = versionRef.current
    // 进入计算态：保留上一版结果供面板展示与继续编辑已有录入，但所有依赖面板统一暂停结果生成
    setState((prev) => ({ ...prev, status: 'computing', error: null, version }))

    // 终止被替代的任务：旧 Worker（及其正在执行的 plan 计算）随即销毁
    workerRef.current?.terminate()
    const worker = new Worker(new URL('../workers/planner.worker.ts', import.meta.url), {
      type: 'module',
    })
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent<PlannerResponse | PlannerFailure>) => {
      // 只有当前版本的消息有效：过期结果/异常不得覆盖新输入的状态
      if (e.data.version !== versionRef.current) return
      const data: PlannerResponse | PlannerFailure = e.data
      if ('result' in data) {
        setState({ result: data.result, status: 'ready', error: null, version: data.version })
      } else {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: data.message,
          version: data.version,
        }))
      }
    }
    worker.onerror = (e) => {
      if (version !== versionRef.current) return
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: e.message || '规划 Worker 发生未知错误',
        version,
      }))
    }

    const request: PlannerRequest = { version, input }
    worker.postMessage(request)
  }, [input])

  // 卸载：取消任务（清空输入时同样会先终止旧任务再提交空快照）
  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  return state
}
