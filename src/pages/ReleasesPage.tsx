import { CalendarClock, Plus } from 'lucide-react'
import { useState } from 'react'
import { ReleaseDetailsDialog } from '../components/ReleaseDetailsDialog'
import { targetProgress } from '../lib/release-progress'
import { StatusBadge } from '../components/StatusBadge'
import { StoreMark } from '../components/StoreMark'
import { PlatformGlyph } from '../components/BrandIcon'
import { formatDate, statusMeta } from '../lib/meta'
import type { BootstrapData } from '../types'

export function ReleasesPage({ data, onNew, onRefresh }: { data: BootstrapData; onNew: () => void; onRefresh: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  return (
    <>
      <header className="page-header page-header--compact">
        <div><p className="eyebrow">执行记录</p><h1>发布任务</h1><p>上传、审核与上架是三个独立阶段。</p></div>
        <button className="button button--primary" onClick={onNew}><Plus size={17} />新建发布</button>
      </header>
      <section className="table-shell">
        <div className="release-table" role="table" aria-label="发布任务">
          <div className="release-table__head" role="row"><span>版本</span><span>目标渠道</span><span>发布策略</span><span>创建时间</span><span>状态</span></div>
          {data.releases.map((release) => {
            const targets = data.targets.filter(({ release_id }) => release_id === release.id)
            return (
              <article className="release-table__row" role="row" key={release.id}>
                <div className="release-version"><PlatformGlyph platform={release.platform} /><div><strong>{release.app_name}</strong><p>v{release.version_name}{release.build_number ? ` (${release.build_number})` : ''}</p></div></div>
                <div className="release-channel-summary">{targets.map((target) => <div key={target.id}><StoreMark store={target.store} showName={false} /><span>{target.error_message || (['submitted', 'reviewing', 'approved', 'live', 'uploaded', 'cancelled', 'rejected', 'withdrawn', 'pending_developer_release'].includes(target.status) ? statusMeta[target.status]?.label : target.status === 'uploading' ? targetProgress(target).text : targetProgress(target).phaseLabel)}</span></div>)}</div>
                <div className="strategy"><CalendarClock size={15} /><span>{strategyLabel[release.strategy] ?? release.strategy}</span></div>
                <time>{formatDate(release.created_at)}</time>
                <div className="release-status"><StatusBadge status={release.status} /><button className="button button--quiet" onClick={() => setSelectedId(release.id)}>{release.status === 'failed' ? '查看失败详情' : ['queued', 'scheduled', 'running'].includes(release.status) ? '查看进度' : '查看详情'}</button></div>
              </article>
            )
          })}
        </div>
      </section>
      {selectedId ? <ReleaseDetailsDialog key={selectedId} id={selectedId} onClose={() => setSelectedId(null)} onUpdated={onRefresh} /> : null}
    </>
  )
}

const strategyLabel: Record<string, string> = {
  automatic: '审核后自动发布',
  manual: '审核后手动发布',
  scheduled_release: '商店定时发布',
  upload_only: '仅上传构建',
}
