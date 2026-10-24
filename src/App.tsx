import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle } from 'lucide-react'
import { Sidebar } from './components/Sidebar'
import { AddAppDialog } from './components/AddAppDialog'
import { CredentialDialog } from './components/CredentialDialog'
import { NewReleaseDialog } from './components/NewReleaseDialog'
import { api } from './lib/api'
import { viewFromPath, viewPaths } from './lib/navigation'
import { Overview } from './pages/Overview'
import { AppsPage } from './pages/AppsPage'
import { CredentialsPage } from './pages/CredentialsPage'
import { ReleasesPage } from './pages/ReleasesPage'
import { SettingsPage } from './pages/SettingsPage'
import type { BootstrapData, StoreKey, ViewKey } from './types'

export default function App() {
  const [data, setData] = useState<BootstrapData | null>(null)
  const [view, setView] = useState<ViewKey>(() => viewFromPath(window.location.pathname))
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<'release' | 'app' | null>(null)
  const [credentialStore, setCredentialStore] = useState<StoreKey | null>(null)

  const navigate = useCallback((next: ViewKey) => {
    if (window.location.pathname !== viewPaths[next]) window.history.pushState(null, '', viewPaths[next])
    setView(next)
  }, [])

  useEffect(() => {
    const onPopState = () => setView(viewFromPath(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true)
    try {
      setData(await api.bootstrap())
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接本地服务')
    } finally {
      if (!quiet) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(true), 10_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const finishModal = useCallback(() => {
    setModal(null)
    setCredentialStore(null)
    void refresh()
  }, [refresh])

  if (!data && !error) return <div className="boot-screen"><span className="brand__symbol"><LoaderCircle className="is-spinning" size={20} /></span><strong>ReleasePort</strong><p>正在连接本地发布服务…</p></div>
  if (!data) return <div className="boot-screen boot-screen--error"><AlertCircle size={24} /><strong>本地服务未连接</strong><p>{error}</p><button className="button button--primary" onClick={() => void refresh()}>重新连接</button></div>

  return (
    <div className="app-shell">
      <Sidebar active={view} onNavigate={navigate} />
      <main>
        {error ? <div className="connection-banner"><AlertCircle size={15} />{error}</div> : null}
        {view === 'overview' ? <Overview data={data} refreshing={refreshing} onRefresh={() => void refresh()} onNavigate={navigate} onNewRelease={() => setModal('release')} /> : null}
        {view === 'apps' ? <AppsPage data={data} onAdd={() => setModal('app')} onRelease={() => setModal('release')} onRefresh={() => void refresh()} /> : null}
        {view === 'releases' ? <ReleasesPage data={data} onNew={() => setModal('release')} onRefresh={() => void refresh(true)} /> : null}
        {view === 'credentials' ? <CredentialsPage data={data} onConfigure={setCredentialStore} onRefresh={() => refresh(true)} /> : null}
        {view === 'settings' ? <SettingsPage data={data} /> : null}
      </main>
      {modal === 'app' ? <AddAppDialog onClose={() => setModal(null)} onSaved={finishModal} /> : null}
      {modal === 'release' ? <NewReleaseDialog data={data} onClose={() => setModal(null)} onCreated={finishModal} /> : null}
      {credentialStore ? <CredentialDialog key={credentialStore} store={credentialStore} configured={data.credentials.some(({ provider }) => provider === credentialStore)} onClose={() => setCredentialStore(null)} onSaved={finishModal} /> : null}
    </div>
  )
}
