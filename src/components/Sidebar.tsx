import { AppWindow, Gauge, KeyRound, Rocket, Settings } from 'lucide-react'
import type { ViewKey } from '../types'
import { PlatformGlyph } from './BrandIcon'
import { viewPaths } from '../lib/navigation'
import type { MouseEvent } from 'react'

const items = [
  { key: 'overview' as const, label: '总览', icon: Gauge },
  { key: 'apps' as const, label: '应用', icon: AppWindow },
  { key: 'releases' as const, label: '发布任务', icon: Rocket },
  { key: 'credentials' as const, label: '平台凭证', icon: KeyRound },
]

export function Sidebar({ active, onNavigate }: { active: ViewKey; onNavigate: (view: ViewKey) => void }) {
  function navigate(event: MouseEvent<HTMLAnchorElement>, view: ViewKey) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onNavigate(view)
  }
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => onNavigate('overview')} aria-label="返回总览">
        <span className="brand__symbol"><PlatformGlyph platform="both" /></span>
        <span><strong>ReleasePort</strong><small>发布控制台</small></span>
      </button>
      <nav aria-label="主导航">
        {items.map(({ key, label, icon: Icon }) => (
          <a key={key} href={viewPaths[key]} aria-current={active === key ? 'page' : undefined} className={active === key ? 'nav-item is-active' : 'nav-item'} onClick={(event) => navigate(event, key)}>
            <Icon size={17} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="sidebar__footer">
        <a href={viewPaths.settings} aria-current={active === 'settings' ? 'page' : undefined} className={active === 'settings' ? 'nav-item is-active' : 'nav-item'} onClick={(event) => navigate(event, 'settings')}>
          <Settings size={17} /><span>运行设置</span>
        </a>
        <div className="local-only"><span />仅本机可访问</div>
      </div>
    </aside>
  )
}
