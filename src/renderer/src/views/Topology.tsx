import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Box, FolderGit2, FolderOpen, GitBranch, Network, Plug, type LucideIcon } from 'lucide-react'
import { store, useStore, type State } from '../model/store'
import { type AXTask, type AXWorkspace, type GitRepo, type Phase, phaseColor, phaseLabel, repoName } from '../model/resources'
import { Empty, PageHeader, PhaseIcon } from '../components'
import { TaskInspectorPane } from './Board'
import '../styles/topology.css'

type Kind =
  | { type: 'repo'; repo: GitRepo }
  | { type: 'mcp'; name: string; endpoint: string }
  | { type: 'workspace'; ws: AXWorkspace | null }
  | { type: 'task'; task: AXTask }

interface GraphNode {
  id: string
  kind: Kind
  x: number // center
  y: number
}

interface GraphEdge {
  id: string
  from: string
  to: string
  d: string
  color: string
  flowing: boolean
}

const NODE_W = 200
const NODE_H = 56
const ROW_H = 76
const GROUP_GAP = 26
const TOP = 40
const COLUMN_X = [130, 420, 720]
const MIN_ZOOM = 0.4
const MAX_ZOOM = 2

/** Horizontal-tangent cubic Bezier from the right edge of one node to the left edge of the next. */
function curve(ax: number, ay: number, bx: number, by: number) {
  const dx = Math.max(40, (bx - ax) / 2)
  return `M${ax},${ay} C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`
}

function layout(s: State) {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let y = TOP

  const tasksUsing = (ws: string) => s.tasks.filter((t) => s.details[t.id]?.workspace === ws)
  const groups: { ws: AXWorkspace | null; tasks: AXTask[] }[] = s.workspaces.map((ws) => ({ ws, tasks: tasksUsing(ws.name) }))
  const unbound = s.tasks.filter((t) => {
    const w = s.details[t.id]?.workspace
    return !w || !s.workspaces.some((ws) => ws.name === w)
  })
  if (unbound.length) groups.push({ ws: null, tasks: unbound })

  for (const g of groups) {
    const sources: Kind[] = [
      ...(g.ws?.repos.map((repo): Kind => ({ type: 'repo', repo })) ?? []),
      ...(g.ws?.mcpServers.map((m): Kind => ({ type: 'mcp', name: m.name, endpoint: m.endpoint })) ?? []),
    ]
    const rows = Math.max(sources.length, g.tasks.length, 1)
    const height = rows * ROW_H
    const wsID = `ws:${g.ws?.name ?? '-'}`
    const wsY = y + height / 2
    nodes.push({ id: wsID, kind: { type: 'workspace', ws: g.ws }, x: COLUMN_X[1], y: wsY })
    const stackY = (i: number, n: number) => y + height / 2 + (i - (n - 1) / 2) * ROW_H

    sources.forEach((src, i) => {
      const id = src.type === 'repo' ? `repo:${wsID}:${src.repo.name}:${src.repo.repo}` : `mcp:${wsID}:${src.type === 'mcp' ? src.name : i}`
      const cy = stackY(i, sources.length)
      nodes.push({ id, kind: src, x: COLUMN_X[0], y: cy })
      edges.push({
        id: `${id}->${wsID}`, from: id, to: wsID,
        d: curve(COLUMN_X[0] + NODE_W / 2, cy, COLUMN_X[1] - NODE_W / 2, wsY),
        color: 'var(--purple)', flowing: false,
      })
    })
    g.tasks.forEach((t, i) => {
      const id = `task:${t.id}`
      const cy = stackY(i, g.tasks.length)
      nodes.push({ id, kind: { type: 'task', task: t }, x: COLUMN_X[2], y: cy })
      edges.push({
        id: `${wsID}->${id}`, from: wsID, to: id,
        d: curve(COLUMN_X[1] + NODE_W / 2, wsY, COLUMN_X[2] - NODE_W / 2, cy),
        color: phaseColor(t.phase), flowing: t.phase === 'running',
      })
    })
    y += height + GROUP_GAP
  }

  // Columns with no nodes (no sources) leave no gap on the left.
  const left = nodes.length ? Math.min(...nodes.map((n) => n.x)) - NODE_W / 2 - 30 : 0
  const width = COLUMN_X[COLUMN_X.length - 1] + NODE_W / 2 + 30 - left
  return { nodes, edges, left, width, height: y + 20 }
}

function describe(k: Kind): { icon: LucideIcon; tint: string; title: string; subtitle: string; tooltip: string } {
  switch (k.type) {
    case 'repo':
      return { icon: GitBranch, tint: 'var(--orange)', title: repoName(k.repo.repo), subtitle: `${k.repo.branch} · ${k.repo.name}`, tooltip: k.repo.repo }
    case 'mcp':
      return { icon: Plug, tint: 'var(--red)', title: k.name, subtitle: 'MCP server', tooltip: k.endpoint }
    case 'workspace': {
      if (!k.ws) return { icon: FolderOpen, tint: 'var(--text-3)', title: 'empty /workspace', subtitle: 'tasks without a workspace', tooltip: 'Tasks with no Workspace start in an empty /workspace' }
      const n = k.ws.repos.length || k.ws.gitCount
      const m = k.ws.mcpServers.length || k.ws.mcpCount
      return { icon: FolderGit2, tint: 'var(--purple)', title: k.ws.name, subtitle: `${n} repo${n === 1 ? '' : 's'} · ${m} MCP`, tooltip: k.ws.name }
    }
    case 'task':
      return { icon: Box, tint: phaseColor(k.task.phase), title: k.task.name, subtitle: `${phaseLabel(k.task.phase)} · ${k.task.age}`, tooltip: `${k.task.name} — click for details` }
  }
}

const LEGEND: Phase[] = ['running', 'pending', 'suspended', 'failed']

export function Topology() {
  const s = useStore()
  const [hover, setHover] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const graph = useMemo(() => layout(s), [s.tasks, s.workspaces, s.details])
  const scroller = useRef<HTMLDivElement>(null)
  const sizer = useRef<HTMLDivElement>(null)
  // The graph point under the pointer during a pinch, kept there after the zoom renders.
  const anchor = useRef<{ x: number; y: number; px: number; py: number } | null>(null)

  // A trackpad pinch arrives as a wheel event with ctrlKey set.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !sizer.current) return
      e.preventDefault()
      const box = el.getBoundingClientRect()
      const px = e.clientX - box.left
      const py = e.clientY - box.top
      setZoom((z) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * Math.exp(-e.deltaY * 0.01)))
        const sz = sizer.current!
        anchor.current = { x: (el.scrollLeft + px - sz.offsetLeft) / z, y: (el.scrollTop + py - sz.offsetTop) / z, px, py }
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useLayoutEffect(() => {
    const a = anchor.current
    const el = scroller.current
    const sz = sizer.current
    if (!a || !el || !sz) return
    anchor.current = null
    el.scrollLeft = a.x * zoom + sz.offsetLeft - a.px
    el.scrollTop = a.y * zoom + sz.offsetTop - a.py
  }, [zoom])

  /** Nodes connected to the hovered one (itself, its neighbors, and one more hop through workspaces). */
  const lit = useMemo(() => {
    if (!hover) return null
    const set = new Set([hover])
    for (const e of graph.edges) {
      if (e.from === hover) set.add(e.to)
      if (e.to === hover) set.add(e.from)
    }
    // A source lights the tasks its workspace feeds; a task lights its workspace's sources.
    if (hover.startsWith('repo:') || hover.startsWith('mcp:')) {
      for (const e of graph.edges) if (e.from.startsWith('ws:') && set.has(e.from)) set.add(e.to)
    } else if (hover.startsWith('task:')) {
      for (const e of graph.edges) if (e.to.startsWith('ws:') && set.has(e.to)) set.add(e.from)
    }
    return set
  }, [hover, graph])
  const edgeLit = (e: GraphEdge) => !lit || (lit.has(e.from) && lit.has(e.to))

  const empty = s.tasks.length === 0 && s.workspaces.length === 0

  return (
    <div className="topology-page">
      <div className="topology">
        <div className="topology-head">
          <PageHeader title="Map" subtitle="How sources feed workspaces and workspaces feed tasks. Running edges flow.">
            <div className="row topo-legend">
              {LEGEND.map((p) => (
                <span key={p} className="row" style={{ gap: 4 }}>
                  <PhaseIcon phase={p} size={12} />
                  <span className="caption muted">{phaseLabel(p)}</span>
                </span>
              ))}
              <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={0.05} value={zoom} title={`Zoom ${Math.round(zoom * 100)}% (pinch to zoom, double-click to reset)`}
                onChange={(e) => setZoom(+e.target.value)} style={{ width: 120, marginLeft: 8 }} />
            </div>
          </PageHeader>
        </div>

        <div className="topo-scroll dotgrid" ref={scroller}
          onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('.topo-node')) setZoom(1) }}>
          {empty ? (
            <Empty icon={Network} title="Nothing to draw yet">Create a Workspace or Task in Deploy to see it here.</Empty>
          ) : (
            <div className="topo-sizer" ref={sizer} style={{ width: graph.width * zoom, height: graph.height * zoom }}>
              <div className="topo-canvas" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom}) translateX(${-graph.left}px)` }}>
                <svg className="topo-edges" width={graph.width + graph.left} height={graph.height}>
                  <g>
                    {graph.edges.map((e) => (
                      <g key={e.id} className="topo-edge" style={{ opacity: edgeLit(e) ? 1 : 0.15 }}>
                        <path d={e.d} fill="none" stroke={e.color} strokeOpacity={e.color === 'var(--purple)' ? 0.55 : 0.8}
                          strokeWidth={lit && edgeLit(e) ? 2.5 : 1.6} />
                        {e.flowing && [0, 0.55, 1.1].map((delay) => (
                          <circle key={delay} r={3.2} fill={e.color}>
                            <animateMotion dur="1.65s" begin={`${delay}s`} repeatCount="indefinite" path={e.d} />
                          </circle>
                        ))}
                      </g>
                    ))}
                  </g>
                </svg>
                {graph.nodes.map((n) => {
                  const d = describe(n.kind)
                  const task = n.kind.type === 'task' ? n.kind.task : null
                  return (
                    <div
                      key={n.id}
                      className={`topo-node card ${task ? 'clickable' : ''} ${hover === n.id ? 'hovered' : ''} ${task && task.id === s.selectedTaskID ? 'selected' : ''}`}
                      title={d.tooltip}
                      style={{
                        left: n.x - NODE_W / 2, top: n.y - NODE_H / 2, width: NODE_W, height: NODE_H,
                        opacity: !lit || lit.has(n.id) ? 1 : 0.25, '--tint': d.tint,
                      } as CSSProperties}
                      onMouseEnter={() => setHover(n.id)}
                      onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                      onClick={() => task && store.set({ selectedTaskID: task.id === s.selectedTaskID ? null : task.id })}
                    >
                      <div className="topo-icon"><d.icon size={16} color={d.tint} /></div>
                      <div className="col topo-text">
                        <div className="topo-title ellipsis">{d.title}</div>
                        <div className="topo-sub ellipsis">{d.subtitle}</div>
                      </div>
                      {task && <PhaseIcon phase={task.phase} size={13} />}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
      <TaskInspectorPane />
    </div>
  )
}
