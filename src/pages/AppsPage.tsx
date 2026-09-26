import { useState } from 'react'
import { MoreHorizontal, Plus, RefreshCw, Rocket, X } from 'lucide-react'
import { StatusBadge } from '../components/StatusBadge'
import { StoreMark } from '../components/StoreMark'
import { PlatformGlyph } from '../components/BrandIcon'
import { api } from '../lib/api'
import { coreStores, formatDate, storeMeta } from '../lib/meta'
import type { AppRecord, BootstrapData } from '../types'

type Props = { data: BootstrapData; onAdd: () => void; onRelease: () => void; onRefresh: () => void }

export function AppsPage({ data, onAdd, onRelease, onRefresh }: Props) {
  const [selectedApp, setSelectedApp] = useState<AppRecord | null>(null)

  return (
    <>
      <header className="page-header page-header--compact">
        <div><p className="eyebrow">应用资产</p><h1>应用</h1><p>管理包标识、渠道版本与发布入口。</p></div>
        <button className="button button--primary" onClick={onAdd}><Plus size={17} />添加应用</button>
      </header>
      <section className="table-shell">
        <div className="table-toolbar"><span>{data.apps.length} 个应用</span><button className="button button--quiet" onClick={onRelease}>新建发布</button></div>
        <div className="app-table" role="table" aria-label="应用列表">
          <div className="app-table__head" role="row"><span>应用</span><span>渠道版本</span><span>活跃状态</span><span>最后更新</span><span /></div>
          {data.apps.map((app) => {
            const channels = data.channels.filter(({ app_id }) => app_id === app.id)
            return (
              <article className="app-table__row" role="row" key={app.id}>
                <div className="app-identity">
                  <AppArtwork app={app} />
                  <div><strong>{app.name}</strong><p>{app.android_package_name ?? app.ios_bundle_id}</p></div>
                </div>
                <div className="store-stack">
                  {channels.slice(0, 8).map((channel) => <span title={`${storeMeta[channel.store].name} ${channel.online_version ?? '未同步'}`} key={channel.id}><StoreMark store={channel.store} showName={false} /></span>)}
                </div>
                <div>{app.issue_channels > 0 ? <StatusBadge status="failed" /> : app.active_channels > 0 ? <StatusBadge status="reviewing" /> : <StatusBadge status="live" />}</div>
                <time>{formatDate(app.updated_at)}</time>
                <button className="icon-button icon-button--small" title="应用操作" onClick={() => setSelectedApp(app)}><MoreHorizontal size={17} /></button>
              </article>
            )
          })}
        </div>
      </section>
      {selectedApp ? <AppActionsDialog app={selectedApp} data={data} onClose={() => setSelectedApp(null)} onRefresh={onRefresh} onRelease={() => { setSelectedApp(null); onRelease() }} /> : null}
    </>
  )
}

function AppArtwork({ app, large = false }: { app: AppRecord; large?: boolean }) {
  if (app.icon_url) return <span className={large ? 'app-icon app-icon--large' : 'app-icon'}><img src={app.icon_url} alt={`${app.name} 图标`} /></span>
  const platform = app.android_package_name && app.ios_bundle_id ? 'both' : app.android_package_name ? 'android' : 'ios'
  return <span className={large ? 'app-icon app-icon--large' : 'app-icon'}><PlatformGlyph platform={platform} /></span>
}

function AppActionsDialog({ app, data, onClose, onRefresh, onRelease }: { app: AppRecord; data: BootstrapData; onClose: () => void; onRefresh: () => void; onRelease: () => void }) {
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState('')
  const channels = data.channels.filter(({ app_id }) => app.id === app_id)
  const stores = coreStores.filter((store) => storeMeta[store].platform === 'android' ? Boolean(app.android_package_name) : Boolean(app.ios_bundle_id))

  async function sync() {
    setSyncing(true)
    setMessage('')
    try {
      const result = await api.syncApp(app.id)
      const success = result.updatedStores.length ? `已同步 ${result.updatedStores.length} 个渠道。` : ''
      setMessage(`${success}${result.warnings.join(' ')}` || '同步完成')
      onRefresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '同步失败')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-actions-title">
        <header><div className="app-dialog__identity"><AppArtwork app={app} large /><div><p className="eyebrow">应用详情</p><h2 id="app-actions-title">{app.name}</h2></div></div><button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></header>
        <div className="app-dialog__body">
          <dl className="app-identifiers">
            {app.android_package_name ? <div><dt>Android</dt><dd>{app.android_package_name}</dd></div> : null}
            {app.ios_bundle_id ? <div><dt>iOS</dt><dd>{app.ios_bundle_id}</dd></div> : null}
          </dl>
          <div className="channel-version-list">
            {stores.map((store) => {
              const channel = channels.find((item) => item.store === store)
              return <article key={store}><StoreMark store={store} /><div><strong>{channel?.online_version ? `线上 v${channel.online_version}` : '线上版本未同步'}</strong><p>{channel?.review_version ? `审核版本 v${channel.review_version}` : channel?.last_synced_at ? `同步于 ${formatDate(channel.last_synced_at)}` : '等待首次同步'}</p></div><StatusBadge status={channel?.status ?? 'unverified'} /></article>
            })}
          </div>
          {message ? <p className="sync-message">{message}</p> : null}
        </div>
        <footer className="dialog-footer"><button className="button button--quiet" onClick={onRelease}><Rocket size={16} />新建发布</button><button className="button button--primary" disabled={syncing} onClick={() => void sync()}><RefreshCw size={16} className={syncing ? 'is-spinning' : ''} />{syncing ? '同步中…' : '同步商店状态'}</button></footer>
      </section>
    </div>
  )
}
