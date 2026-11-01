import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ChartGantt } from 'lucide-react'
import { type PhaseChange, phaseLogKey, store, useStore } from '../model/store'
import { type AXTask, type Phase, type TaskDetail, phaseColor, phaseLabel } from '../model/resources'
import { Empty, PageHeader, PhaseIcon, Segmented } from '../components'
import { TaskInspectorPane } from './Board'
import '../styles/timeline.css'

type Range = 'fit' | '5m' | '15m' | '1h' | 'all'
const RANGES: { value: Range; label: string; ms: number }[] = [
  { value: 'fit', label: 'Fit', ms: 0 },
  { value: '5m', label: '5m', ms: 5 * 60e3 },
  { value: '15m', label: '15m', ms: 15 * 60e3 },
  { value: '1h', label: '1h', ms: 60 * 60e3 },
  { value: 'all', label: 'All', ms: 0 },
]
const RANGE_KEY = 'ax-studio.timeline-range'
const MIN_SPAN = 10e3
const MAX_SPAN = 7 * 24 * 3600e3
const STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400].map((s) => s * 1e3)

/** A stretch of a task's life: waiting to start, running, or stopped after running. */
interface Span { kind: 'waiting' | 'run' | 'stopped'; from: number; to: number; phase: Phase }

interface Row { task: AXTask; detail?: TaskDetail; created?: number; spans: Span[]; stopUnknown: boolean }

const time = (iso?: string) => (iso ? Date.parse(iso) : NaN)

/**
 * A task's history: created at createTime, first started when WorkspaceReady
 * was set, then the phase changes the app saw on refresh. ax doesn't record
 * when a task stopped, so a task that stopped while the app wasn't watching
 * shows its start and no length.
 */
function spans(task: AXTask, d: TaskDetail | undefined, changes: PhaseChange[], now: number): Omit<Row, 'task' | 'detail'> {
  const created = time(d?.createTime)
  if (!d || isNaN(created)) return { spans: [], stopUnknown: false }
  const started = time(d.conditions.find((c) => c.type === 'WorkspaceReady' && c.status === 'True')?.updateTime)
  const marks: { at: number; phase: Phase }[] = [{ at: created, phase: 'pending' }]
  if (!isNaN(started)) marks.push({ at: started, phase: 'running' })
  for (const c of changes) {
    // WorkspaceReady times the first start exactly; a refresh only brackets it.
    if (c.at !== null && c.at > created && !(c.phase === 'running' && c.at < started)) marks.push({ at: c.at, phase: c.phase })
  }
  marks.sort((a, b) => a.at - b.at)
  let stopUnknown = false
  if (task.phase !== 'running' && marks[marks.length - 1].phase === 'running') {
    marks.push({ at: marks[marks.length - 1].at, phase: task.phase })
    stopUnknown = true
  }
  const out: Span[] = []
  let ran = false
  for (const m of marks) {
    const kind: Span['kind'] = m.phase === 'running' ? 'run' : ran || m.phase === 'failed' ? 'stopped' : 'waiting'
    ran ||= kind === 'run'
    const last = out[out.length - 1]
    if (last?.kind === kind) continue
    if (last) last.to = m.at
    out.push({ kind, from: m.at, to: now, phase: m.phase })
  }
  return { created, spans: out, stopUnknown }
}

const clock = (t: number, seconds: boolean) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })

function duration(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function tooltip(r: Row) {
  const parts = [r.task.name, `${phaseLabel(r.task.phase)}`]
  if (r.created) parts.push(`created ${clock(r.created, true)}`)
  for (const run of r.spans.filter((s) => s.kind === 'run')) {
    const open = run.to >= Date.now() - 1000 && r.task.phase === 'running'
    parts.push(r.stopUnknown && run.from === run.to
      ? `started ${clock(run.from, true)}, stop time not seen`
      : `${open ? 'running' : 'ran'} ${clock(run.from, true)}–${open ? 'now' : clock(run.to, true)} (${duration(run.to - run.from)})`)
  }
  return parts.join(' · ')
}

export function Timeline() {
  const s = useStore()
  const [range, setRangeState] = useState<Range>(() => RANGES.find((r) => r.value === localStorage.getItem(RANGE_KEY))?.value ?? 'fit')
  const [now, setNow] = useState(Date.now())
  // A pinch or pan replaces the range with an explicit window; end is null while it follows now.
  const [view, setView] = useState<{ span: number; end: number | null } | null>(null)
  const setRange = (r: Range) => { localStorage.setItem(RANGE_KEY, r); setRangeState(r); setView(null) }
  const scroller = useRef<HTMLDivElement>(null)
  const axis = useRef<HTMLDivElement>(null)
  const win = useRef({ start: 0, span: 1, now: 0 })

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const rows: Row[] = useMemo(
    () => s.tasks
      .map((task) => {
        const detail = s.details[task.id]
        return { task, detail, ...spans(task, detail, s.phaseLog[phaseLogKey(task, detail)] ?? [], now) }
      })
      .sort((a, b) => (a.created ?? Infinity) - (b.created ?? Infinity) || a.task.name.localeCompare(b.task.name)),
    [s.tasks, s.details, s.phaseLog, now],
  )

  // Fit starts at the earliest task created in the last hour, so one long-lived task doesn't flatten the rest.
  const created = rows.map((r) => r.created ?? now)
  const recent = created.filter((t) => t > now - 60 * 60e3)
  const earliest = Math.min(...(range === 'fit' && recent.length ? recent : created), now)
  const rangeSpan = range === 'fit' || range === 'all' ? Math.max(30e3, (now - earliest) * 1.06) : RANGES.find((r) => r.value === range)!.ms
  const span = view?.span ?? rangeSpan
  const end = view?.end ?? now
  const live = end === now
  const start = end - span
  win.current = { start, span, now }
  const x = (t: number) => `${(Math.max(0, Math.min(1, (t - start) / span))) * 100}%`
  const width = (from: number, to: number) => `${Math.max(0, (Math.min(to, end) - Math.max(from, start)) / span) * 100}%`

  // A trackpad pinch (a wheel event with ctrlKey) zooms around the pointer; a sideways swipe pans.
  const hasRows = rows.length > 0
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const track = axis.current?.getBoundingClientRect()
      const pan = !e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)
      if (!track || (!e.ctrlKey && !pan)) return
      e.preventDefault()
      const w = win.current
      let next: { span: number; end: number }
      if (e.ctrlKey) {
        const frac = Math.max(0, Math.min(1, (e.clientX - track.left) / track.width))
        const at = w.start + frac * w.span
        const span = Math.max(MIN_SPAN, Math.min(MAX_SPAN, w.span * Math.exp(e.deltaY * 0.01)))
        next = { span, end: at + (1 - frac) * span }
      } else {
        next = { span: w.span, end: w.start + w.span + (e.deltaX * w.span) / track.width }
      }
      setView({ span: next.span, end: next.end >= w.now ? null : next.end })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [hasRows])

  const step = STEPS.find((st) => span / st <= 8) ?? STEPS[STEPS.length - 1]
  const ticks: number[] = []
  // Leave room for the "now" label at the right edge.
  for (let t = Math.ceil(start / step) * step; t <= end - (live ? span * 0.08 : 0); t += step) ticks.push(t)
  const seconds = step < 60e3

  return (
    <div className="timeline-page">
      <div className="timeline">
        <div className="timeline-head">
          <PageHeader title="Timeline" subtitle="When each task waited, ran and stopped.">
            <div className="row tl-legend">
              <span className="row" style={{ gap: 5 }}><span className="tl-key waiting" /><span className="caption muted">Waiting</span></span>
              <span className="row" style={{ gap: 5 }}><span className="tl-key run" style={{ '--c': phaseColor('running') } as CSSProperties} /><span className="caption muted">Running</span></span>
              <span className="row" style={{ gap: 5 }}><span className="tl-key stopped" style={{ '--c': phaseColor('suspended') } as CSSProperties} /><span className="caption muted">Suspended</span></span>
              {view && <button className="btn small ghost" title="Back to the selected range (or double-click the timeline)" onClick={() => setView(null)}>Reset zoom</button>}
              <Segmented value={range} options={RANGES.map(({ value, label }) => ({ value, label }))} onChange={setRange} />
            </div>
          </PageHeader>
        </div>

        {rows.length === 0 ? (
          <div className="tl-scroll">
            <Empty icon={ChartGantt} title="No tasks yet">Tasks appear here as they are created, with how long each waited and ran.</Empty>
          </div>
        ) : (
          <div className="tl-scroll" ref={scroller} onDoubleClick={() => setView(null)}
            title="Pinch to zoom, swipe sideways to pan, double-click to reset">
            <div className="tl-grid">
              <div className="tl-axis-row">
                <div className="tl-label caption faint">{rows.length} task{rows.length === 1 ? '' : 's'}</div>
                <div className="tl-track tl-axis" ref={axis}>
                  {ticks.map((t) => <span key={t} className="tl-tick caption faint" style={{ left: x(t) }}>{clock(t, seconds)}</span>)}
                  {live && <span className="tl-tick now caption" style={{ left: '100%' }}>now</span>}
                </div>
              </div>
              <div className="tl-body">
                <div className="tl-gridlines">
                  {ticks.map((t) => <span key={t} style={{ left: x(t) }} />)}
                  {live && <span className="now" style={{ left: '100%' }} />}
                </div>
                {rows.map((r) => {
                  const selected = r.task.id === s.selectedTaskID
                  return (
                    <div key={r.task.id} className={`tl-row ${selected ? 'selected' : ''}`} title={tooltip(r)}
                      onClick={() => store.set({ selectedTaskID: selected ? null : r.task.id })}>
                      <div className="tl-label">
                        <PhaseIcon phase={r.task.phase} size={13} />
                        <div className="col" style={{ minWidth: 0 }}>
                          <span className="tl-name ellipsis">{r.task.name}</span>
                          <span className="tl-ws caption faint ellipsis">{r.detail?.workspace ?? 'no workspace'}</span>
                        </div>
                      </div>
                      <div className="tl-track">
                        {r.spans.filter((sp) => sp.to > start && sp.from < end).map((sp, i) => (
                          <span key={i} className={`tl-span ${sp.kind} ${sp.kind !== 'stopped' && sp.to >= now - 1 && live ? 'open' : ''}`}
                            style={{ left: x(sp.from), width: width(sp.from, sp.to), '--c': phaseColor(sp.phase) } as CSSProperties} />
                        ))}
                        {r.created && r.created < start && <span className="tl-clipped caption faint">←</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>
      <TaskInspectorPane />
    </div>
  )
}
