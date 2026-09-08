import { useParams } from 'react-router'

/**
 * S02 route stub. Every route in 06-frontend-architecture.md §2 is reachable
 * from day one so the router, the guards, and the 404 fallback are wired
 * before any screen exists to fill them.
 */
export function Placeholder({ title }: { title: string }) {
  const params = useParams()
  const entries = Object.entries(params).filter(([, v]) => v !== undefined)

  return (
    <main className="placeholder">
      <h1>{title}</h1>
      {entries.length > 0 && (
        <dl>
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </main>
  )
}
