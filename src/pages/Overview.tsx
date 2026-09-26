import { ArrowUpRight, CheckCircle2, Clock3, KeyRound, PackageCheck, RefreshCw, Rocket } from 'lucide-react'
import { coreStores, formatDate, storeMeta } from '../lib/meta'
import { StatusBadge } from '../components/StatusBadge'
import { StoreMark } from '../components/StoreMark'
import { PlatformGlyph } from '../components/BrandIcon'
import type { BootstrapData, ViewKey } from '../types'

type Props = {
  data: BootstrapData
  refreshing: boolean
  onRefresh: () => void
  onNavigate: (view: ViewKey) => void
  onNewRelease: () => void
}

export function Overview({ data, refreshing, onRefresh, onNavigate, onNewRelease }: Props) {
  const recentReleases = data.releases.slice(0, 4)
  const reviewChannels = data.channels.filter(({ status }) => ['reviewing', 'submitted', 'pending_developer_release'].includes(status))

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Release Center</p>
          <h1>发布总览</h1>
          <p><em>{reviewChannels.length}</em> 个渠道正在流转 · 最后同步于 {formatDate(new Date().toISOString())}</p>
        </div>
        <div className="header-actions">
          <button className="icon-button" title="刷新全部状态" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw size={17} className={refreshing ? 'is-spinning' : ''} />
          </button>
          <button className="button button--primary" onClick={onNewRelease}><Rocket size={17} />新建发布</button>
        </div>
      </header>

      <section className="metric-grid" aria-label="发布概况">
        <article className="metric">
          <span className="metric__icon metric__icon--ink"><PackageCheck size={18} /></span>
          <div><strong>{data.summary.apps}</strong><span>管理中的应用</span></div>
          <button title="查看应用" onClick={() => onNavigate('apps')}><ArrowUpRight size={16} /></button>
        </article>
        <article className="metric">
          <span className="metric__icon metric__icon--amber"><Clock3 size={18} /></span>
          <div><strong>{data.summary.activeReleases}</strong><span>活跃发布任务</span></div>
          <button title="查看任务" onClick={() => onNavigate('releases')}><ArrowUpRight size={16} /></button>
        </article>
        <article className="metric">
          <span className="metric__icon metric__icon--green"><CheckCircle2 size={18} /></span>
          <div><strong>{data.summary.publishedReleases}</strong><span>已完成版本</span></div>
          <button title="查看历史" onClick={() => onNavigate('releases')}><ArrowUpRight size={16} /></button>
        </article>
        <article className="metric">
          <span className="metric__icon metric__icon--blue"><KeyRound size={18} /></span>
          <div><strong>{data.summary.configuredCredentials}<small> / {coreStores.length}</small></strong><span>已配置平台</span></div>
          <button title="管理凭证" onClick={() => onNavigate('credentials')}><ArrowUpRight size={16} /></button>
        </article>
      </section>

      <div className="overview-grid">
        <section className="panel">
          <div className="panel__header"><div><h2>最近发布</h2><p>跨平台任务执行与审核进度</p></div><button className="text-button" onClick={() => onNavigate('releases')}>查看全部</button></div>
          {recentReleases.length ? (
            <div className="release-list">
              {recentReleases.map((release) => (
                <article className="release-row" key={release.id}>
                  <PlatformGlyph platform={release.platform} />
                  <div className="release-row__main">
                    <strong>{release.app_name} <span>v{release.version_name}</span></strong>
                    <p>{release.target_count} 个渠道 · {formatDate(release.created_at)}</p>
                  </div>
                  <StatusBadge status={release.status} />
                </article>
              ))}
            </div>
          ) : <EmptyMini text="还没有发布任务" />}
        </section>

        <section className="panel">
          <div className="panel__header"><div><h2>渠道动态</h2><p>当前需要关注的商店状态</p></div><span className="panel-count">{reviewChannels.length}</span></div>
          {reviewChannels.length ? (
            <div className="channel-feed">
              {reviewChannels.slice(0, 5).map((channel) => {
                const app = data.apps.find(({ id }) => id === channel.app_id)
                return (
                  <article key={channel.id}>
                    <StoreMark store={channel.store} />
                    <div><strong>{app?.name ?? '未知应用'}</strong><p>{channel.review_version ? `v${channel.review_version}` : '版本待确认'} · {storeMeta[channel.store].platform === 'ios' ? 'iOS' : 'Android'}</p></div>
                    <StatusBadge status={channel.status} />
                  </article>
                )
              })}
            </div>
          ) : <EmptyMini text="当前没有待处理渠道" />}
        </section>
      </div>
    </>
  )
}

function EmptyMini({ text }: { text: string }) {
  return <div className="empty-mini"><CheckCircle2 size={20} /><span>{text}</span></div>
}
