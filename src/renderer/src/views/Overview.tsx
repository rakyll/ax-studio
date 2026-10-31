import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { CircleCheck, Cpu, FolderGit2, GitBranch, Layers3, TriangleAlert, Unplug, type LucideIcon } from 'lucide-react'
import { store, useStore, type PhaseSample } from '../model/store'
import { PHASES, type Phase, phaseColor, phaseLabel, shortName } from '../model/resources'
import { Chip, PageHeader, PhaseIcon, since } from '../components'
import '../styles/overview.css'

export function Overview() {
  const s = useStore()
  const ctx = store.currentContext
  const subtitle = `${ctx ? (ctx.name === 'local' ? 'local control plane' : shortName(ctx.name)) : '…'} · atespace ${s.atespace}`

  return (
    <div className="page">
      <PageHeader title="Overview" subtitle={subtitle} />
      {s.connectionError && s.tasks.length === 0 && <ConnectionProblem message={s.connectionError} />}
      <div className="tiles">
        <StatTile title="Tasks" value={s.tasks.length} icon={Layers3} tint="var(--accent)" go="board" />
        {(['running', 'suspended', 'failed'] as Phase[]).map((p) => (
          <StatTile key={p} title={phaseLabel(p)} value={store.tasksIn(p).length} phase={p} tint={phaseColor(p)} go="board" />
        ))}
        <StatTile title="Workspaces" value={s.workspaces.length} icon={FolderGit2} tint="var(--purple)" go="topology" />
        <StatTile title="Models" value={s.models.length} icon={Cpu} tint="var(--teal)" go="topology" />
      </div>
      <div className="overview-grid">
        <div className="col" style={{ gap: 16, minWidth: 0 }}>
          <PhaseDistribution />
          <TasksOverTime />
        </div>
        <div className="col" style={{ gap: 16 }}>
          <ResourceList />
          <ActivityFeed />
        </div>
      </div>
    </div>
  )
}

function StatTile({ title, value, icon: Icon, phase, tint, go }: {
  title: string
  value: number
  icon?: LucideIcon
  phase?: Phase
  tint: string
  go: 'board' | 'topology'
}) {
  return (
    <button className="tile card" style={{ '--tint': tint } as CSSProperties} onClick={() => store.setSection(go)}>
      <div className="row tile-title">
        {phase ? <PhaseIcon phase={phase} size={15} /> : Icon && <Icon size={15} color={tint} />}
        <span>{title}</span>
      </div>
      <div className="tile-value" key={value}>{value}</div>
    </button>
  )
}

/** One stacked bar: how the current tasks split across phases. */
function PhaseDistribution() {
  const s = useStore()
  const segments = PHASES.map((p) => ({ phase: p, count: s.tasks.filter((t) => t.phase === p).length })).filter((x) => x.count)
  return (
    <section className="card pad">
      <h2 className="card-title">Phase distribution</h2>
      {segments.length === 0 ? (
        <div className="muted" style={{ height: 56 }}>No tasks in this atespace yet.</div>
      ) : (
        <>
          {/* Segments sit on a 2px surface gap; hover shows the exact count. */}
          <div className="dist-bar">
            {segments.map((x) => (
              <div key={x.phase} className="dist-seg" title={`${phaseLabel(x.phase)}: ${x.count}`}
                style={{ flexGrow: x.count, background: phaseColor(x.phase) }}>
                {x.count}
              </div>
            ))}
          </div>
          <div className="legend">
            {segments.map((x) => (
              <span key={x.phase} className="row" style={{ gap: 5 }}>
                <PhaseIcon phase={x.phase} size={12} />
                <span className="muted">{phaseLabel(x.phase)}</span>
                <span className="num">{x.count}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

/** Phase counts sampled at each refresh this session, as a stacked area with a crosshair tooltip. */
function TasksOverTime() {
  const s = useStore()
  const [hover, setHover] = useState<number | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const W = 800
  const H = 200
  const pad = { l: 30, r: 8, t: 10, b: 22 }
  const history = s.history

  const seen = useMemo(() => PHASES.filter((p) => history.some((h) => (h.counts[p] ?? 0) > 0)), [history])

  const chart = useMemo(() => {
    if (history.length < 2) return null
    const t0 = history[0].date
    const t1 = history[history.length - 1].date
    const maxY = Math.max(1, ...history.map((h) => seen.reduce((a, p) => a + (h.counts[p] ?? 0), 0)))
    const niceMax = maxY <= 5 ? maxY : Math.ceil(maxY / 4) * 4
    const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r)
    const y = (v: number) => H - pad.b - (v / niceMax) * (H - pad.t - pad.b)
    // Stack in lifecycle order: each band's top is the running sum.
    const bands = seen.map((p, i) => {
      const lower = history.map((h) => seen.slice(0, i).reduce((a, q) => a + (h.counts[q] ?? 0), 0))
      const upper = history.map((h, j) => lower[j] + (h.counts[p] ?? 0))
      const top = history.map((h, j) => `${x(h.date)},${y(upper[j])}`)
      const bottom = history.map((h, j) => `${x(h.date)},${y(lower[j])}`).reverse()
      return { phase: p, d: `M${top.join('L')}L${bottom.join('L')}Z`, line: `M${top.join('L')}` }
    })
    const ticks = niceMax <= 5 ? Array.from({ length: niceMax + 1 }, (_, i) => i) : [0, niceMax / 2, niceMax]
    return { x, y, bands, ticks, t0, t1 }
  }, [history, seen])

  const onMove = (e: React.MouseEvent) => {
    if (!chart || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    let best = 0
    history.forEach((h, i) => {
      if (Math.abs(chart.x(h.date) - px) < Math.abs(chart.x(history[best].date) - px)) best = i
    })
    setHover(best)
  }

  const h: PhaseSample | null = hover !== null ? history[hover] ?? null : null
  const hx = h && chart ? chart.x(h.date) : 0

  return (
    <section className="card pad">
      <div className="row">
        <h2 className="card-title" style={{ margin: 0 }}>Tasks over time</h2>
        <div className="spacer" />
        <span className="caption faint">this session</span>
      </div>
      {!chart ? (
        <div className="muted center" style={{ height: 200 }}>Collecting samples…</div>
      ) : (
        <div className="chart" ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H}>
            {chart.ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={chart.y(t)} y2={chart.y(t)} className="gridline" />
              </g>
            ))}
            {chart.bands.map((b) => (
              <g key={b.phase}>
                <path d={b.d} fill={phaseColor(b.phase)} opacity={0.82} />
                <path d={b.line} fill="none" stroke={phaseColor(b.phase)} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              </g>
            ))}
            {h && <line x1={hx} x2={hx} y1={pad.t} y2={H - pad.b} className="crosshair" vectorEffect="non-scaling-stroke" />}
          </svg>
          {/* Axis labels in HTML so they don't stretch with the SVG. */}
          {chart.ticks.map((t) => (
            <span key={t} className="axis-y" style={{ top: chart.y(t) - 7 }}>{t}</span>
          ))}
          <span className="axis-x" style={{ left: 0 }}>{new Date(chart.t0).toLocaleTimeString()}</span>
          <span className="axis-x" style={{ right: 0 }}>{new Date(chart.t1).toLocaleTimeString()}</span>
          {h && (
            <div className="tooltip" style={{ left: `calc(${(hx / W) * 100}% + ${hx / W > 0.7 ? -170 : 12}px)`, top: 8, width: 158 }}>
              <div className="caption faint" style={{ marginBottom: 4 }}>{new Date(h.date).toLocaleTimeString()}</div>
              {seen.map((p) => (
                <div key={p} className="row" style={{ gap: 6 }}>
                  <span className="swatch" style={{ background: phaseColor(p) }} />
                  <span>{phaseLabel(p)}</span>
                  <span className="spacer" />
                  <span className="num">{h.counts[p] ?? 0}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {chart && (
        <div className="legend">
          {seen.map((p) => (
            <span key={p} className="row" style={{ gap: 5 }}>
              <span className="swatch" style={{ background: phaseColor(p) }} />
              <span className="muted">{phaseLabel(p)}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function ResourceList() {
  const s = useStore()
  return (
    <section className="card pad">
      <h2 className="card-title">Resources</h2>
      {s.workspaces.length === 0 && s.models.length === 0 && <div className="muted">No workspaces or models.</div>}
      <div className="col" style={{ gap: 9 }}>
        {s.workspaces.map((w) => (
          <div key={w.id} className="row res-row">
            <FolderGit2 size={15} color="var(--purple)" />
            <span className="ellipsis">{w.name}</span>
            <span className="spacer" />
            <Chip icon={GitBranch} title="Git repos">{w.gitCount}</Chip>
            <Chip icon={Layers3} title="Tasks using it">{store.tasksUsing(w.name).length}</Chip>
          </div>
        ))}
        {s.models.map((m) => (
          <div key={m.id} className="row res-row">
            <Cpu size={15} color="var(--teal)" />
            <span className="ellipsis">{m.name}</span>
            <span className="spacer" />
            <span className="caption muted ellipsis">{m.provider} · {m.model}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function ActivityFeed() {
  const s = useStore()
  return (
    <section className="card pad">
      <h2 className="card-title">Activity</h2>
      {s.activity.length === 0 && <div className="muted">Actions you take here show up in this feed.</div>}
      <div className="col" style={{ gap: 10 }}>
        {s.activity.slice(0, 12).map((e) => (
          <div key={e.id} className="row fade-in" style={{ alignItems: 'flex-start' }}>
            {e.ok ? <CircleCheck size={15} color="var(--green)" /> : <TriangleAlert size={15} color="var(--red)" />}
            <div className="col" style={{ minWidth: 0, flex: 1 }}>
              <span style={{ fontWeight: 500 }}>{e.title}</span>
              {e.detail && <span className="caption muted clamp3 selectable">{e.detail}</span>}
            </div>
            <span className="caption faint">{since(e.date)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function ConnectionProblem({ message }: { message: string }) {
  return (
    <div className="card highlight pad row problem" style={{ '--tint': 'var(--red)' } as CSSProperties}>
      <Unplug size={26} color="var(--red)" />
      <div className="col" style={{ flex: 1, minWidth: 0 }}>
        <strong>Can't reach the AX control plane</strong>
        <span className="muted selectable">{message}</span>
      </div>
      <button className="btn" onClick={() => store.setSection('deploy')}>Open Deploy</button>
    </div>
  )
}
