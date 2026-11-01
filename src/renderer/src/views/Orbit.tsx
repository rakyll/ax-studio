import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Orbit as OrbitIcon } from 'lucide-react'
import { store, useStore } from '../model/store'
import { type AXTask, phaseColor, phaseLabel, repoName } from '../model/resources'
import { workspaceGroups, type WorkspaceGroup } from '../model/groups'
import { Empty, PageHeader, PhaseIcon } from '../components'
import { TaskInspectorPane } from './Board'
import '../styles/orbit.css'

const TASK_GAP = 34 // arc length per task on the outer ring
const CHAR_W = 6.4 // rough width of a label character, for fitting the view
const MIN_ZOOM = 0.5
const MAX_ZOOM = 4

interface Moon { key: string; kind: 'repo' | 'mcp'; label: string; x: number; y: number }
interface WsNode { group: WorkspaceGroup; x: number; y: number; angle: number; from: number; to: number; spoke: string; moons: Moon[] }
interface TaskNode { task: AXTask; ws: string; x: number; y: number; angle: number; path: string }
interface Box { x: number; y: number; w: number; h: number }

const polar = (r: number, a: number) => [r * Math.cos(a), r * Math.sin(a)] as const
const f = (n: number) => n.toFixed(1)

/** An arc along a circle of radius r, from angle a to b. */
function arc(r: number, a: number, b: number) {
  const [x1, y1] = polar(r, a)
  const [x2, y2] = polar(r, b)
  return `M${f(x1)},${f(y1)} A${r},${r} 0 ${b - a > Math.PI ? 1 : 0} 1 ${f(x2)},${f(y2)}`
}

/**
 * The atespace sits at the center, workspaces on an inner ring, and each
 * workspace's tasks orbit it on the outer ring in a sector sized to fit them.
 */
function layout(groups: WorkspaceGroup[]) {
  // A minimum share keeps small workspaces from crowding each other.
  const weights = groups.map((g) => Math.max(2.5, g.tasks.length))
  const total = weights.reduce((a, b) => a + b, 0)
  const outer = Math.max(200, (total * TASK_GAP) / (2 * Math.PI))
  const inner = Math.max(105, outer * 0.48)
  const ws: WsNode[] = []
  const tasks: TaskNode[] = []
  let a0 = -Math.PI / 2
  groups.forEach((g, i) => {
    const sector = (weights[i] / total) * 2 * Math.PI
    const mid = a0 + sector / 2
    const [wx, wy] = polar(inner, mid)
    // Sources hang on the side of the workspace facing the center.
    const sources = [
      ...(g.ws?.repos.map((r) => ({ key: `r:${r.name}:${r.repo}`, kind: 'repo' as const, label: `${repoName(r.repo)} (${r.branch})` })) ?? []),
      ...(g.ws?.mcpServers.map((m) => ({ key: `m:${m.name}`, kind: 'mcp' as const, label: `${m.name} · ${m.endpoint}` })) ?? []),
    ]
    const moons = sources.map((src, j) => {
      const a = mid + Math.PI + (j - (sources.length - 1) / 2) * 0.55
      const [mx, my] = polar(29, a)
      return { ...src, x: mx, y: my }
    })
    ws.push({ group: g, x: wx, y: wy, angle: mid, from: a0, to: a0 + sector, spoke: `M0,0 L${f(wx)},${f(wy)}`, moons })
    g.tasks.forEach((t, j) => {
      const angle = a0 + ((j + 0.5) / g.tasks.length) * sector
      const [x, y] = polar(outer, angle)
      const [cx, cy] = polar((inner + outer) / 2, (mid + angle) / 2)
      tasks.push({ task: t, ws: g.id, x, y, angle, path: `M${f(wx)},${f(wy)} Q${f(cx)},${f(cy)} ${f(x)},${f(y)}` })
    })
    a0 += sector
  })
  // Fit the view to the nodes and the labels that radiate out of them.
  let minX = -outer - 20, maxX = outer + 20, minY = -outer - 20, maxY = outer + 20
  for (const t of tasks) {
    const [lx, ly] = polar(Math.hypot(t.x, t.y) + 16 + t.task.name.length * CHAR_W, t.angle)
    minX = Math.min(minX, lx); maxX = Math.max(maxX, lx); minY = Math.min(minY, ly); maxY = Math.max(maxY, ly)
  }
  const pad = 24
  const fit: Box = { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad }
  return { ws, tasks, inner, outer, fit }
}

export function Orbit() {
  const s = useStore()
  const [hover, setHover] = useState<string | null>(null)
  // A pinch or pan replaces the fitted view; null follows the layout.
  const [view, setView] = useState<Box | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const groups = useMemo(() => workspaceGroups(s), [s.tasks, s.workspaces, s.details])
  const g = useMemo(() => layout(groups), [groups])
  const box = view ?? g.fit
  const boxRef = useRef(box)
  boxRef.current = box
  const fitRef = useRef(g.fit)
  fitRef.current = g.fit

  const selected = g.tasks.find((t) => t.task.id === s.selectedTaskID)
  const focus = hover ?? null
  const lit = (wsID: string) => !focus || focus === wsID
  const running = s.tasks.filter((t) => t.phase === 'running').length

  // A trackpad pinch (a wheel event with ctrlKey) zooms around the pointer; two-finger scrolling pans.
  const hasGroups = groups.length > 0
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const ctm = el.getScreenCTM()
      if (!ctm) return
      const b = boxRef.current
      if (e.ctrlKey) {
        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
        const zoom = fitRef.current.w / b.w
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * Math.exp(-e.deltaY * 0.01)))
        const k = zoom / next
        setView({ x: p.x - (p.x - b.x) * k, y: p.y - (p.y - b.y) * k, w: b.w * k, h: b.h * k })
      } else {
        setView({ ...b, x: b.x + e.deltaX / ctm.a, y: b.y + e.deltaY / ctm.d })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [hasGroups])

  return (
    <div className="orbit-page">
      <div className="orbit">
        <div className="orbit-head">
          <PageHeader title="Orbit" subtitle="Workspaces circle the atespace and tasks orbit their workspace. Pinch to zoom, double-click to fit." />
        </div>
        <div className="orbit-stage dotgrid">
          {groups.length === 0 ? (
            <Empty icon={OrbitIcon} title="Nothing in orbit">Create a Workspace or Task in the Designer to see it here.</Empty>
          ) : (
            <svg ref={svg} className="orbit-svg" viewBox={`${f(box.x)} ${f(box.y)} ${f(box.w)} ${f(box.h)}`} preserveAspectRatio="xMidYMid meet"
              onDoubleClick={() => setView(null)}>
              <circle className="orbit-ring" r={g.inner} />
              <circle className="orbit-ring" r={g.outer} />

              {/* Each workspace's sector of the outer ring. */}
              {g.ws.map((w) => (
                <path key={w.group.id} className={`orbit-sector ${focus === w.group.id ? 'on' : ''}`}
                  style={{ d: `path("${arc(g.outer, w.from + 0.02, w.to - 0.02)}")` } as CSSProperties} />
              ))}

              {g.ws.map((w) => (
                <path key={w.group.id} className={`orbit-spoke ${selected?.ws === w.group.id ? 'on' : ''}`}
                  style={{ d: `path("${w.spoke}")`, opacity: lit(w.group.id) ? 1 : 0.15 } as CSSProperties} />
              ))}
              {g.tasks.map((t) => (
                <path key={t.task.id} className={`orbit-link ${t.task.phase === 'running' ? 'flowing' : ''} ${selected === t ? 'on' : ''}`}
                  stroke={phaseColor(t.task.phase)} style={{ d: `path("${t.path}")`, opacity: lit(t.ws) ? 1 : 0.1 } as CSSProperties} />
              ))}

              <g className="orbit-core">
                <circle r={50} />
                <text y={-6} className="orbit-core-name">{s.atespace}</text>
                <text y={10} className="orbit-core-sub">{s.context}</text>
                <text y={24} className="orbit-core-sub">{s.tasks.length} tasks · {running} running</text>
              </g>

              {g.ws.map((w) => {
                const n = w.group.tasks.length
                const label = w.group.ws?.name ?? 'empty /workspace'
                return (
                  <g key={w.group.id} className="orbit-ws" style={{ transform: `translate(${f(w.x)}px, ${f(w.y)}px)`, opacity: lit(w.group.id) ? 1 : 0.3 }}
                    onMouseEnter={() => setHover(w.group.id)} onMouseLeave={() => setHover(null)}>
                    <g className="orbit-pop">
                      <title>{`${label}: ${n} task${n === 1 ? '' : 's'}`}</title>
                      {w.moons.map((m) => (
                        <g key={m.key}>
                          <title>{m.kind === 'repo' ? `Repo ${m.label}` : `MCP server ${m.label}`}</title>
                          <line x1={0} y1={0} x2={m.x} y2={m.y} className="orbit-tether" />
                          <circle cx={m.x} cy={m.y} r={4.5} className={`orbit-moon ${m.kind}`} />
                        </g>
                      ))}
                      <circle r={20} className={`orbit-ws-body ${w.group.ws ? '' : 'unbound'}`} />
                      <text className="orbit-ws-count" y={4}>{n}</text>
                      <text className="orbit-ws-name" y={34} textAnchor="middle">{label}</text>
                    </g>
                  </g>
                )
              })}

              {g.tasks.map((t) => {
                const deg = (t.angle * 180) / Math.PI
                const flip = Math.cos(t.angle) < 0
                const isSelected = selected === t
                const idle = t.task.phase !== 'running'
                return (
                  <g key={t.task.id} className={`orbit-task ${isSelected ? 'selected' : ''} ${idle ? 'idle' : ''}`}
                    style={{ transform: `translate(${f(t.x)}px, ${f(t.y)}px)`, opacity: lit(t.ws) ? 1 : 0.2 }}
                    onMouseEnter={() => setHover(t.ws)} onMouseLeave={() => setHover(null)}
                    onClick={() => store.set({ selectedTaskID: isSelected ? null : t.task.id })}>
                    <g className="orbit-pop">
                      <title>{`${t.task.name} · ${phaseLabel(t.task.phase)} · ${t.task.age}`}</title>
                      {!idle && <circle className="orbit-halo" r={9} fill={phaseColor('running')} />}
                      <circle r={isSelected ? 9 : idle ? 6 : 8} fill={phaseColor(t.task.phase)} className="orbit-dot" />
                      <text className="orbit-task-name" transform={`rotate(${f(flip ? deg + 180 : deg)})`}
                        x={flip ? -14 : 14} y={4} textAnchor={flip ? 'end' : 'start'}>{t.task.name}</text>
                    </g>
                  </g>
                )
              })}
            </svg>
          )}
          {groups.length > 0 && (
            <div className="row orbit-legend">
              {(['running', 'pending', 'suspended', 'failed'] as const).map((p) => (
                <span key={p} className="row" style={{ gap: 4 }}><PhaseIcon phase={p} size={12} /><span className="caption muted">{phaseLabel(p)}</span></span>
              ))}
              <span className="row" style={{ gap: 4 }}><span className="orbit-key repo" /><span className="caption muted">Repo</span></span>
              <span className="row" style={{ gap: 4 }}><span className="orbit-key mcp" /><span className="caption muted">MCP</span></span>
            </div>
          )}
          {view && <button className="btn small orbit-fit" onClick={() => setView(null)}>Fit</button>}
        </div>
      </div>
      <TaskInspectorPane />
    </div>
  )
}
