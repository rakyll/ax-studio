import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'
import { useStore } from '../model/store'
import type { AXTask } from '../model/resources'

interface LogLine { id: number; time: string; text: string; runner: boolean }

/** Lines kept per task; older ones scroll away. */
const MAX_LINES = 2000
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
let streams = 0

/**
 * Follows a task's output. On Kubernetes, Substrate writes each sandbox
 * container's stdout and stderr to its worker pod's log as JSON lines labeled
 * with the actor; the task's own process runs in the "guest" container.
 * The local control plane runs tasks elsewhere, so logs aren't shown there.
 */
export function TaskLogs({ task: t }: { task: AXTask }) {
  const s = useStore()
  const kube = s.context !== '' && s.context !== 'local'
  const [lines, setLines] = useState<LogLine[]>([])
  const [status, setStatus] = useState<'following' | 'ended' | 'failed'>('following')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [expanded, setExpanded] = useState(() => new URLSearchParams(location.search).get('logs') === 'expanded')
  const box = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    if (!kube) return
    setLines([])
    setStatus('following')
    setError('')
    const id = `task-logs-${++streams}`
    let next = 1
    let pending: LogLine[] = []
    let flush: ReturnType<typeof setTimeout> | null = null
    let other = ''
    const offLine = window.studio.onStreamLine((l) => {
      if (l.id !== id) return
      let rec: { labels?: Record<string, string>; message?: string; time?: string }
      try {
        rec = JSON.parse(l.line)
      } catch {
        // Not a sandbox record: kubectl's own errors, or a worker's plain log line.
        if (/^error:|forbidden|not found|unable to/i.test(l.line)) other = l.line
        return
      }
      const lab = rec.labels
      if (!lab || lab['ate.actor.name'] !== t.name || lab['ate.atespace'] !== t.atespace || lab['ate.actor.container.name'] !== 'guest') return
      const text = rec.message ?? ''
      pending.push({ id: next++, time: rec.time ?? '', text, runner: /^time=\S+ level=\w+ msg=/.test(text) })
      flush ??= setTimeout(() => {
        const add = pending
        pending = []
        flush = null
        setLines((prev) => [...prev, ...add].slice(-MAX_LINES))
      }, 100)
    })
    const offExit = window.studio.onStreamExit((e) => {
      if (e.id !== id) return
      setStatus(e.status === 0 ? 'ended' : 'failed')
      if (e.status !== 0) setError(other || `kubectl exited with status ${e.status}`)
    })
    const kc = `kubectl${s.context === 'kube' ? '' : ` --context ${shq(s.context)}`}`
    // Worker pools aren't only in ax-system, and kubectl logs can't span
    // namespaces, so follow each namespace that has worker pods.
    const namespaces = `$(${kc} get pods -A -l ate.dev/worker-pool -o jsonpath='{range .items[*]}{.metadata.namespace}{"\\n"}{end}' | sort -u)`
    void window.studio.stream({
      id,
      commandLine: `for ns in ${namespaces}; do ${kc} -n "$ns" logs -l ate.dev/worker-pool --all-containers --prefix=false --ignore-errors -f --since=24h --tail=-1 --max-log-requests=50 2>&1 & done; wait`,
    })
    return () => {
      offLine()
      offExit()
      if (flush) clearTimeout(flush)
      void window.studio.cancelStream(id)
    }
  }, [kube, s.context, t.name, t.atespace, attempt])

  // Stay at the bottom unless the user scrolled up to read.
  useEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [lines, expanded])

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setExpanded(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  if (!kube) {
    return <p className="caption muted">Logs are shown for tasks on a Kubernetes context; the local control plane runs tasks as containers on this machine.</p>
  }
  const body = (
    <>
      <pre
        ref={box}
        className="sandbox-output task-logs selectable"
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {lines.length === 0 && (
          <span className="faint">
            {status === 'following' ? 'Waiting for output…' : status === 'failed' ? error : 'No output in the last 24 hours.'}
          </span>
        )}
        {lines.map((l) => (
          <div key={l.id} className={l.runner ? 'runner' : undefined} title={l.time}>{l.text}</div>
        ))}
      </pre>
      <div className="row task-logs-foot caption faint">
        {status === 'following' && <span className="pulse on" style={{ '--c': 'var(--green)' } as CSSProperties} />}
        <span>{status === 'following' ? 'Following' : status === 'failed' ? 'Stopped' : 'Ended'} · {lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
        <span className="spacer" />
        {lines.length > 0 && (
          <button className="btn small ghost" onClick={() => void navigator.clipboard.writeText(lines.map((l) => l.text).join('\n'))}>Copy</button>
        )}
        {status !== 'following' && (
          <button className="btn small ghost" onClick={() => setAttempt((a) => a + 1)}>Reconnect</button>
        )}
        <button className="btn small ghost" title={expanded ? 'Collapse (Esc)' : 'Expand'} onClick={() => setExpanded((x) => !x)}>
          {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
    </>
  )
  if (!expanded) return body
  return (
    <>
      <p className="caption faint">Logs are open in a larger view.</p>
      <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setExpanded(false)}>
        <div className="card task-logs-modal">
          <div className="row task-logs-title">
            <strong>{t.name}</strong>
            <span className="faint">logs</span>
          </div>
          {body}
        </div>
      </div>
    </>
  )
}
