import { CalendarClock, Plus } from 'lucide-react'
import { StatusBadge } from '../components/StatusBadge'
import { StoreMark } from '../components/StoreMark'
import { PlatformGlyph } from '../components/BrandIcon'
import { formatDate } from '../lib/meta'
import type { BootstrapData } from '../types'

export function ReleasesPage({ data, onNew }: { data: BootstrapData; onNew: () => void }) {
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
                <div className="store-stack">{targets.map((target) => <StoreMark key={target.id} store={target.store} showName={false} />)}</div>
                <div className="strategy"><CalendarClock size={15} /><span>{strategyLabel[release.strategy] ?? release.strategy}</span></div>
                <time>{formatDate(release.created_at)}</time>
                <StatusBadge status={release.status} />
              </article>
            )
          })}
        </div>
      </section>
    </>
  )
}

const strategyLabel: Record<string, string> = {
  automatic: '审核后自动发布',
  manual: '审核后手动发布',
  scheduled_release: '商店定时发布',
  upload_only: '仅上传构建',
}
