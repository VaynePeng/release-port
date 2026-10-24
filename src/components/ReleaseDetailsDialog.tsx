import { useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { api } from '../lib/api'
import { storeMeta } from '../lib/meta'
import { bytesLabel, targetProgress } from '../lib/release-progress'
import type { ReleaseDetails } from '../types'
import { StatusBadge } from './StatusBadge'
import { StoreMark } from './StoreMark'

const categories: Record<string, string> = {
  icon_invalid: '安装包图标解析失败',
  rate_limited: '商店请求限流', auth_failed: '凭证鉴权失败', missing_tool: '缺少执行工具',
  config_invalid: '配置错误', version_check_failed: '发布前版本校验失败', release_notes_failed: '更新说明提交失败',
  incomplete_result: '工具未返回完整结果', unknown: '工具未分类的错误',
}
const eventNames: Record<string, string> = {
  store_review_synced: '商店审核结果已同步',
  package_icon_prepared: '已按安装包配置准备图标',
  package_icon_uploaded: '商店已确认图标上传',
  store_cancellation_recorded: '已记录商店取消（用户确认）',
  execution_started: '启动发布工具', execution_finished: '发布工具结束',
  target_status: '渠道阶段变化', target_result: '渠道执行结果', tool_log: '工具输出',
  release_notes_prepared: '版本说明已准备', release_notes_updated: '版本说明已更新', unparsed_output: '工具原始输出',
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value))
}

function eventMessage(raw: string) {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return Object.entries(value).map(([key, item]) => `${key}: ${typeof item === 'object' ? JSON.stringify(item) : String(item)}`).join('\n')
  } catch { return raw }
}

export function ReleaseDetailsDialog({ id, onClose, onUpdated }: { id: string; onClose: () => void; onUpdated?: () => void }) {
  const [details, setDetails] = useState<ReleaseDetails | null>(null)
  const [error, setError] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  async function syncReview() {
    setSyncing(true)
    setSyncMessage('')
    try {
      const result = await api.syncRelease(id)
      setDetails(result.details)
      setSyncMessage(result.warnings.join(' ') || `已同步 ${result.updatedStores.length} 个渠道`)
      onUpdated?.()
    } catch (reason) { setSyncMessage(reason instanceof Error ? reason.message : '查询失败') }
    finally { setSyncing(false) }
  }
  async function recordCancellation(targetId: string) {
    setRecording(targetId)
    setActionError('')
    try {
      setDetails(await api.recordStoreCancellation(id, targetId))
      onUpdated?.()
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : '无法记录取消状态') }
    finally { setRecording(null) }
  }
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    async function refresh() {
      try {
        const next = await api.releaseDetails(id)
        if (!active) return
        setDetails(next)
        setError('')
        timer = setTimeout(() => void refresh(), ['queued', 'scheduled', 'running'].includes(next.release.status) ? 2000 : 10_000)
      } catch (reason) {
        if (!active) return
        setError(reason instanceof Error ? reason.message : '无法读取任务详情')
        timer = setTimeout(() => void refresh(), 5000)
      }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [id])
  const release = details?.release
  const elapsed = release?.started_at ? Math.max(0, Math.round((new Date(release.finished_at ?? Date.now()).getTime() - new Date(release.started_at).getTime()) / 1000)) : null
  return (
    <div className="dialog-backdrop">
      <section className="dialog release-details-dialog" role="dialog" aria-modal="true" aria-labelledby="release-details-title">
        <header><div><p className="eyebrow">发布任务详情</p><h2 id="release-details-title">{release ? `${release.app_name} · ${release.version_name}${release.build_number ? ` (${release.build_number})` : ''}` : '正在读取任务…'}</h2></div><button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></header>
        <div className="release-details-body">
          {error ? <p role="alert" className="form-error">{error}（保留上次已读数据，正在重试）</p> : null}
          {actionError ? <p role="alert" className="form-error">{actionError}</p> : null}
          {release ? <>
            <div className="release-detail-status"><StatusBadge status={release.status} /><span>{['queued', 'scheduled', 'running'].includes(release.status) ? '每 2 秒更新执行进度' : '执行结果已记录'}</span></div>
            <dl className="release-facts">
              <div><dt>安装包</dt><dd>{release.artifact_name ?? '未记录'}{release.artifact_size ? ` · ${bytesLabel(release.artifact_size)}` : ''}</dd></div>
              <div><dt>创建时间</dt><dd>{formatDate(release.created_at)}</dd></div>
              <div><dt>开始执行</dt><dd>{release.started_at ? formatDate(release.started_at) : '尚未开始'}</dd></div>
              <div><dt>执行结束</dt><dd>{release.finished_at ? formatDate(release.finished_at) : '尚未结束'}{elapsed !== null ? ` · 耗时 ${elapsed} 秒` : ''}</dd></div>
              {release.submit_at ? <div><dt>计划提交</dt><dd>{formatDate(release.submit_at)}</dd></div> : null}
              {release.store_release_at ? <div><dt>计划上架</dt><dd>{formatDate(release.store_release_at)}</dd></div> : null}
              <div><dt>任务 ID</dt><dd>{id}</dd></div>
            </dl>
            <h3>各渠道进度与审核结果</h3>
            <p className="form-hint">后台每 15 分钟查询已提交任务；页面每 10 秒读取已保存结果。手动查询间隔至少 60 秒。</p>
            <button className="button button--quiet" disabled={syncing || ['queued','scheduled','running'].includes(release.status)} onClick={() => void syncReview()}><RefreshCw size={16} className={syncing ? 'is-spinning' : ''} />{syncing ? '查询中…' : '同步审核状态'}</button>
            {syncMessage ? <p role="status" className="form-hint">{syncMessage}</p> : null}
            {details.targets.map((target) => {
              const progress = targetProgress(target)
              return <article className="release-target-detail" key={target.id}>
                <div className="release-target-heading"><StoreMark store={target.store} /><StatusBadge status={target.status} /></div>
                <p>{target.status === 'failed' ? '失败阶段' : release.status === 'running' ? '当前执行阶段' : '最后执行阶段'}：<strong>{progress.phaseLabel}</strong>{progress.inferred ? '（依据错误日志判断）' : ''}</p>
                <p>{progress.text}</p>
                {progress.percent !== null ? <progress aria-label={`${storeMeta[target.store].name}上传进度`} max={100} value={progress.percent} /> : null}
                {target.phase_started_at ? <p>阶段开始：{formatDate(target.phase_started_at)}</p> : null}
                <p>最近更新：{formatDate(target.updated_at)}</p>
                {target.error_message ? <div role="alert" className="release-error-detail"><strong>{categories[target.error_category || (/\[-20035\]/.test(target.error_message ?? '') ? 'rate_limited' : '')] ?? '发布失败'}</strong><pre>{target.error_message}</pre>{/\[-20035\]/.test(target.error_message) ? <p>小米返回请求过于频繁。本次失败发生在查询阶段；需降低查询频率后再重试。</p> : null}</div> : null}
                {target.review_checked_at ? <div className="review-observation">
                  <p><strong>商店审核结果</strong>：{target.review_status ? <StatusBadge status={target.review_status} /> : '尚未确认本次任务的审核状态'}</p>
                  <p>{target.review_detail}</p>
                  {target.review_status === 'rejected' ? <p>拒绝原因以商店返回说明为准；只有状态码时需前往商店后台查看完整原因。</p> : null}
                  {target.review_sync_error ? <p role="alert" className="form-error">本次查询失败（保留上次结果）：{target.review_sync_error}</p> : null}
                  <p className="form-hint">来源：{target.review_source === 'app_store_connect' ? 'App Store Connect 官方 API' : target.review_source === 'google_play_api' ? 'Google Play 官方 API' : target.review_source === 'honor_api' ? '荣耀官方 API' : 'ApkGo 商店查询'} · 最近查询：{formatDate(target.review_checked_at)}</p>
                </div> : null}
                {target.status_source === 'user_confirmation'  ? <p className="form-hint">状态来源：用户确认。{target.status_note}</p> : null}
                {['submitted', 'reviewing', 'approved', 'pending_developer_release'].includes(target.status) ? <>
                  <p className="form-hint">{target.status_source === 'store_api' ? '状态来自商店查询。' : '这是本地提交记录，尚未确认后续审核状态。'}{target.store === 'xiaomi' ? '小米未开放审核或撤回状态查询接口。' : target.store === 'honor' && !target.external_id ? '当前工具缺少本次提交的 releaseId，无法准确查询审核结果。' : ['pgyer','fir'].includes(target.store) ? '当前渠道未接入审核状态查询，请在商店后台查看。' : ''}</p>
                  {release.status !== 'running' ? <><p className="form-hint">若已在商店后台取消或撤回，可更新本地记录。</p><button className="button button--quiet" disabled={recording !== null} onClick={() => void recordCancellation(target.id)}>{recording === target.id ? '正在记录…' : '已在商店取消，更新记录'}</button></> : null}
                </> : null}
              </article>
            })}
            <h3>本次版本更新说明</h3><pre className="release-notes-text">{release.release_notes}</pre>
            <h3>执行时间线与日志</h3><p className="form-hint">最新日志在最前，展示最近 300 条已记录事件。旧任务缺少的阶段和字节数据无法追溯补录。</p>
            {details.events.length ? <ol className="release-event-list">{details.events.map((event) => <li key={event.id}><div><time>{formatDate(event.created_at)}</time><strong>{eventNames[event.event_type] ?? event.event_type}</strong></div><pre>{eventMessage(event.message)}</pre></li>)}</ol> : <p>该任务没有可用的执行日志。</p>}
          </> : !error ? <p role="status">正在读取执行进度…</p> : null}
        </div>
      </section>
    </div>
  )
}
