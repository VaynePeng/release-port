import { AppWindow, Gauge, KeyRound, Rocket, Settings } from 'lucide-react'
import type { ViewKey } from '../types'
import { PlatformGlyph } from './BrandIcon'

const items = [
  { key: 'overview' as const, label: '总览', icon: Gauge },
  { key: 'apps' as const, label: '应用', icon: AppWindow },
  { key: 'releases' as const, label: '发布任务', icon: Rocket },
  { key: 'credentials' as const, label: '平台凭证', icon: KeyRound },
]

export function Sidebar({ active, onNavigate }: { active: ViewKey; onNavigate: (view: ViewKey) => void }) {
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => onNavigate('overview')} aria-label="返回总览">
        <span className="brand__symbol"><PlatformGlyph platform="both" /></span>
        <span><strong>ReleasePort</strong><small>发布控制台</small></span>
      </button>
      <nav aria-label="主导航">
        {items.map(({ key, label, icon: Icon }) => (
          <button key={key} className={active === key ? 'nav-item is-active' : 'nav-item'} onClick={() => onNavigate(key)}>
            <Icon size={17} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar__footer">
        <button className={active === 'settings' ? 'nav-item is-active' : 'nav-item'} onClick={() => onNavigate('settings')}>
          <Settings size={17} /><span>运行设置</span>
        </button>
        <div className="local-only"><span />仅本机可访问</div>
      </div>
    </aside>
  )
}
