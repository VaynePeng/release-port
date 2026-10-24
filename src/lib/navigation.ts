import type { ViewKey } from '../types'

export const viewPaths: Record<ViewKey, string> = {
  overview: '/', apps: '/apps', releases: '/releases', credentials: '/credentials', settings: '/settings',
}

export function viewFromPath(pathname: string): ViewKey {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  return (Object.entries(viewPaths).find(([, path]) => path === normalized)?.[0] as ViewKey | undefined) ?? 'overview'
}
