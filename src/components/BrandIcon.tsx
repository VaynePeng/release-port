import {
  siAndroid,
  siApple,
  siAppstore,
  siFastlane,
  siGoogleplay,
  siHonor,
  siHuawei,
  siMeizu,
  siOppo,
  siQq,
  siSamsung,
  siVivo,
  siXiaomi,
  type SimpleIcon,
} from 'simple-icons'
import type { StoreKey } from '../types'

const storeIcons: Partial<Record<StoreKey, SimpleIcon>> = {
  huawei: siHuawei,
  xiaomi: siXiaomi,
  honor: siHonor,
  oppo: siOppo,
  vivo: siVivo,
  meizu: siMeizu,
  tencent: siQq,
  samsung: siSamsung,
  googleplay: siGoogleplay,
  apple: siAppstore,
}

export function BrandIcon({ icon, label, className }: { icon: SimpleIcon; label?: string; className?: string }) {
  return (
    <svg className={className} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} viewBox="0 0 24 24" fill="currentColor">
      <path d={icon.path} />
    </svg>
  )
}

export function StoreLogo({ store, className }: { store: StoreKey; className?: string }) {
  const icon = storeIcons[store]
  if (!icon) return <span className={`store-wordmark ${className ?? ''}`} aria-label={store === 'pgyer' ? '蒲公英' : 'fir.im'}>{store === 'pgyer' ? 'P' : 'fir'}</span>
  return <BrandIcon icon={icon} label={icon.title} className={className} />
}

export function PlatformGlyph({ platform, className = '' }: { platform: 'android' | 'ios' | 'both'; className?: string }) {
  if (platform === 'both') {
    return (
      <span className={`platform-icon platform-icon--both ${className}`} aria-label="Android 和 iOS">
        <BrandIcon icon={siAndroid} />
        <BrandIcon icon={siApple} />
      </span>
    )
  }
  const icon = platform === 'android' ? siAndroid : siAppstore
  return <span className={`platform-icon platform-icon--${platform} ${className}`}><BrandIcon icon={icon} label={icon.title} /></span>
}

export function ToolLogo({ tool }: { tool: 'apkgo' | 'fastlane' }) {
  const icon = tool === 'apkgo' ? siAndroid : siFastlane
  return <span className={`tool-logo tool-logo--${tool}`}><BrandIcon icon={icon} label={icon.title} /></span>
}
