import type { ReleaseTarget } from '../types'
import { statusMeta } from './meta'

export function bytesLabel(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function targetProgress(target: ReleaseTarget) {
  const phase = target.phase || target.error_message?.match(/^([a-z_]+):/)?.[1]
  const phaseLabel = phase ? statusMeta[phase]?.label ?? phase : '未记录阶段'
  const measured = target.total_bytes > 0
  const percent = measured ? Math.min(100, Math.max(0, target.progress_bytes / target.total_bytes * 100)) : null
  return {
    phaseLabel,
    inferred: !target.phase && Boolean(phase),
    percent,
    text: measured ? `${bytesLabel(target.progress_bytes)} / ${bytesLabel(target.total_bytes)} · ${percent!.toFixed(1)}%`
      : target.progress_bytes > 0 ? `已上传 ${bytesLabel(target.progress_bytes)}，工具未提供总量`
        : phase === 'query' && target.status === 'failed' ? '查询版本时失败，尚未进入上传阶段'
          : target.store === 'apple' ? '执行工具未提供上传字节进度' : '尚无上传字节进度记录',
  }
}
