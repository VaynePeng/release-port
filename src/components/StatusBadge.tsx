import { statusMeta } from '../lib/meta'

export function StatusBadge({ status }: { status: string }) {
  const meta = statusMeta[status] ?? { label: status, tone: 'neutral' as const }
  return <span className={`status status--${meta.tone}`}><i aria-hidden="true" />{meta.label}</span>
}
