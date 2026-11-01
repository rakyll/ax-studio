import { useMemo, useState } from 'react'
import { Orbit as OrbitIcon } from 'lucide-react'
import { store, useStore } from '../model/store'
import { type AXTask, phaseColor, phaseLabel } from '../model/resources'
import { workspaceGroups, type WorkspaceGroup } from '../model/groups'
import { Empty, PageHeader, PhaseIcon } from '../components'
import { TaskInspectorPane } from './Board'
import '../styles/orbit.css'

const TASK_GAP = 30 // arc length per task on the outer ring
const LABEL_W = 170 // room for task names outside the ring

interface WsNode { group: WorkspaceGroup; x: number; y: number; angle: number }
interface TaskNode { task: AXTask; ws: string; x: number; y: number; angle: number; r: number; path: string }

const polar = (r: number, a: number) => [r * Math.cos(a), r * Math.sin(a)] as const

/**
 * The atespace sits at the center, workspaces on an inner ring, and each
 * workspace's tasks orbit it on the outer ring in a sector sized to fit them.
 */
function layout(groups: WorkspaceGroup[]) {
  // A minimum share keeps small workspaces from crowding each other.
  const weights = groups.map((g) => Math.max(2.5, g.tasks.length))
  const total = weights.reduce((a, b) => a + b, 0)
  const outer = Math.max(220, (total * TASK_GAP) / (2 * Math.PI))
  const inner = Math.max(110, outer * 0.48)
  const ws: WsNode[] = []
  const tasks: TaskNode[] = []
  let a0 = -Math.PI / 2
  groups.forEach((g, i) => {
    const sector = (weights[i] / total) * 2 * Math.PI
    const mid = a0 + sector / 2
    const [wx, wy] = polar(inner, mid)
    ws.push({ group: g, x: wx, y: wy, angle: mid })
    g.tasks.forEach((t, j) => {
      const angle = a0 + ((j + 0.5) / g.tasks.length) * sector
      const [x, y] = polar(outer, angle)
      const [cx, cy] = polar((inner + outer) / 2, angle)
      tasks.push({ task: t, ws: g.id, x, y, angle, r: outer, path: `M${wx},${wy} Q${cx},${cy} ${x},${y}` })
    })
    a0 += sector
  })
  return { ws, tasks, inner, outer, size: 2 * (outer + LABEL_W) }
}

export function Orbit() {
  const s = useStore()
  const [hover, setHover] = useState<string | null>(null)
  const groups = useMemo(() => workspaceGroups(s), [s.tasks, s.workspaces, s.details])
  const g = useMemo(() => layout(groups), [groups])
  const lit = (wsID: string) => !hover || hover === wsID
  const running = s.tasks.filter((t) => t.phase === 'running').length

  return (
    <div className="orbit-page">
      <div className="orbit">
        <div className="orbit-head">
          <PageHeader title="Orbit" subtitle="Workspaces circle the atespace and tasks orbit their workspace. Hover a workspace to focus it." />
        </div>
        <div className="orbit-stage dotgrid">
          {groups.length === 0 ? (
            <Empty icon={OrbitIcon} title="Nothing in orbit">Create a Workspace or Task in the Designer to see it here.</Empty>
          ) : (
            <svg className="orbit-svg" viewBox={`${-g.size / 2} ${-g.size / 2} ${g.size} ${g.size}`} preserveAspectRatio="xMidYMid meet">
              <circle className="orbit-ring" r={g.inner} />
              <circle className="orbit-ring" r={g.outer} />

              {g.ws.map((w) => (
                <line key={w.group.id} className="orbit-spoke" x1={0} y1={0} x2={w.x} y2={w.y} style={{ opacity: lit(w.group.id) ? 1 : 0.15 }} />
              ))}
              {g.tasks.map((t) => (
                <path key={t.task.id} d={t.path} className={`orbit-link ${t.task.phase === 'running' ? 'flowing' : ''}`}
                  stroke={phaseColor(t.task.phase)} style={{ opacity: lit(t.ws) ? 1 : 0.12 }} />
              ))}

              <g className="orbit-core">
                <circle r={48} />
                <text y={-4} className="orbit-core-name">{s.atespace}</text>
                <text y={14} className="orbit-core-sub">{s.tasks.length} tasks · {running} running</text>
              </g>

              {g.ws.map((w) => {
                const n = w.group.tasks.length
                const label = w.group.ws?.name ?? 'empty /workspace'
                return (
                  <g key={w.group.id} className="orbit-ws" transform={`translate(${w.x},${w.y})`} style={{ opacity: lit(w.group.id) ? 1 : 0.3 }}
                    onMouseEnter={() => setHover(w.group.id)} onMouseLeave={() => setHover(null)}>
                    <title>{`${label}: ${n} task${n === 1 ? '' : 's'}${w.group.ws ? `, ${w.group.ws.repos.length || w.group.ws.gitCount} repos, ${w.group.ws.mcpServers.length || w.group.ws.mcpCount} MCP` : ''}`}</title>
                    <circle r={20} className={w.group.ws ? '' : 'unbound'} />
                    <text className="orbit-ws-count" y={4}>{n}</text>
                    <text className="orbit-ws-name" x={Math.cos(w.angle) * 30} y={Math.sin(w.angle) * 30 + 4}
                      textAnchor={Math.abs(Math.cos(w.angle)) < 0.3 ? 'middle' : Math.cos(w.angle) > 0 ? 'start' : 'end'}
                      dy={Math.abs(Math.cos(w.angle)) < 0.3 ? Math.sign(Math.sin(w.angle)) * 6 : 0}>{label}</text>
                  </g>
                )
              })}

              {g.tasks.map((t) => {
                const deg = (t.angle * 180) / Math.PI
                const flip = Math.cos(t.angle) < 0
                const selected = t.task.id === s.selectedTaskID
                return (
                  <g key={t.task.id} className={`orbit-task ${selected ? 'selected' : ''}`} style={{ opacity: lit(t.ws) ? 1 : 0.25 }}
                    onMouseEnter={() => setHover(t.ws)} onMouseLeave={() => setHover(null)}
                    onClick={() => store.set({ selectedTaskID: selected ? null : t.task.id })}>
                    <title>{`${t.task.name} · ${phaseLabel(t.task.phase)} · ${t.task.age}`}</title>
                    {t.task.phase === 'running' && <circle className="orbit-halo" cx={t.x} cy={t.y} r={9} fill={phaseColor('running')} />}
                    <circle cx={t.x} cy={t.y} r={selected ? 9 : 7} fill={phaseColor(t.task.phase)} className="orbit-dot" />
                    <text className="orbit-task-name" transform={`translate(${t.x},${t.y}) rotate(${flip ? deg + 180 : deg})`}
                      x={flip ? -14 : 14} y={4} textAnchor={flip ? 'end' : 'start'}>{t.task.name}</text>
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
            </div>
          )}
        </div>
      </div>
      <TaskInspectorPane />
    </div>
  )
}
