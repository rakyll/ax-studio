import { useMemo, useState, type CSSProperties } from 'react'
import { Box, FolderGit2, FolderOpen, GitBranch, LayoutGrid, Plug } from 'lucide-react'
import { store, useStore } from '../model/store'
import { type AXTask, type Phase, PHASES, phaseColor, phaseLabel, repoName } from '../model/resources'
import { cores, workspaceGroups, type WorkspaceGroup } from '../model/groups'
import { Empty, PageHeader, PhaseIcon, PulseDot, Segmented } from '../components'
import { TaskInspectorPane } from './Board'
import '../styles/fleet.css'

type Filter = 'all' | 'running' | 'idle'

/** Every task as a tile inside its workspace: a map of the fleet you can scan at a glance. */
export function Fleet() {
  const s = useStore()
  const [filter, setFilter] = useState<Filter>('all')
  const groups = useMemo(() => workspaceGroups(s), [s.tasks, s.workspaces, s.details])
  const keep = (t: AXTask) => filter === 'all' || (filter === 'running') === (t.phase === 'running')
  const counts = PHASES.map((p) => [p, s.tasks.filter((t) => t.phase === p).length] as const).filter(([, n]) => n > 0)

  return (
    <div className="fleet-page">
      <div className="fleet">
        <div className="fleet-head">
          <PageHeader title="Fleet" subtitle="Every task as a tile in its workspace.">
            <div className="row fleet-summary">
              {counts.map(([p, n]) => (
                <span key={p} className="row" style={{ gap: 4 }}>
                  <PhaseIcon phase={p} size={12} />
                  <span className="caption muted">{n} {phaseLabel(p).toLowerCase()}</span>
                </span>
              ))}
              <Segmented value={filter} onChange={setFilter}
                options={[{ value: 'all', label: 'All' }, { value: 'running', label: 'Running' }, { value: 'idle', label: 'Not running' }]} />
            </div>
          </PageHeader>
        </div>
        <div className="fleet-scroll">
          {groups.length === 0 ? (
            <Empty icon={LayoutGrid} title="No tasks or workspaces">Create a Workspace or Task in the Designer to see it here.</Empty>
          ) : (
            <div className="fleet-groups">
              {groups.map((g) => <GroupCard key={g.id} group={g} tasks={g.tasks.filter(keep)} />)}
            </div>
          )}
        </div>
      </div>
      <TaskInspectorPane />
    </div>
  )
}

function GroupCard({ group, tasks }: { group: WorkspaceGroup; tasks: AXTask[] }) {
  const { ws } = group
  const running = group.tasks.filter((t) => t.phase === 'running').length
  return (
    <section className="card fleet-group">
      <header className="fleet-group-head">
        <div className="fleet-ws-icon">{ws ? <FolderGit2 size={15} /> : <FolderOpen size={15} />}</div>
        <div className="col" style={{ minWidth: 0, flex: 1 }}>
          <span className="fleet-ws-name ellipsis">{ws?.name ?? 'empty /workspace'}</span>
          <span className="caption faint">
            {group.tasks.length} task{group.tasks.length === 1 ? '' : 's'}{running > 0 && ` · ${running} running`}
          </span>
        </div>
        {running > 0 && <PulseDot color={phaseColor('running')} />}
      </header>
      {ws && (ws.repos.length > 0 || ws.mcpServers.length > 0) && (
        <div className="fleet-sources">
          {ws.repos.map((r) => <span key={r.name + r.repo} className="fleet-source" title={r.repo}><GitBranch size={11} />{repoName(r.repo)}</span>)}
          {ws.mcpServers.map((m) => <span key={m.name} className="fleet-source" title={m.endpoint}><Plug size={11} />{m.name}</span>)}
        </div>
      )}
      <div className="fleet-tiles">
        {tasks.map((t) => <Tile key={t.id} task={t} />)}
        {tasks.length === 0 && <span className="caption faint fleet-none">{group.tasks.length ? 'None match the filter' : 'No tasks use this workspace'}</span>}
      </div>
    </section>
  )
}

function Tile({ task }: { task: AXTask }) {
  const s = useStore()
  const d = s.details[task.id]
  const cpu = cores(d?.cpu)
  const selected = s.selectedTaskID === task.id
  return (
    <button className={`fleet-tile ${task.phase} ${selected ? 'selected' : ''}`} style={{ '--c': phaseColor(task.phase as Phase) } as CSSProperties}
      title={`${task.name} · ${phaseLabel(task.phase)} · ${task.age}`}
      onClick={() => store.set({ selectedTaskID: selected ? null : task.id })}>
      <div className="row fleet-tile-top">
        <PhaseIcon phase={task.phase} size={12} />
        <span className="caption fleet-tile-phase">{phaseLabel(task.phase)}</span>
        <span className="caption faint" style={{ marginLeft: 'auto' }}>{task.age}</span>
      </div>
      <div className="fleet-tile-name ellipsis">{task.name}</div>
      <div className="row fleet-tile-meta caption faint">
        <Box size={11} />
        <span className="ellipsis">{cpu !== undefined ? `${cpu} CPU` : 'no limit'}{d?.memory ? ` · ${d.memory}` : ''}</span>
      </div>
    </button>
  )
}
