import { storeMeta } from '../lib/meta'
import type { StoreKey } from '../types'
import { StoreLogo } from './BrandIcon'

export function StoreMark({ store, showName = true }: { store: StoreKey; showName?: boolean }) {
  const meta = storeMeta[store]
  return (
    <span className="store-mark">
      <span className="store-mark__icon" style={{ '--store-color': meta.color } as React.CSSProperties}><StoreLogo store={store} /></span>
      {showName ? <span>{meta.name}</span> : null}
    </span>
  )
}
