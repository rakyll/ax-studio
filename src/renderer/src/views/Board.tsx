import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  ArrowDown, ArrowUp, ArrowUpDown, Bolt, Check, ChevronRight, CircleCheck, CircleX, Copy, FolderGit2, Pause, Play,
  Plus, Rows3, Terminal, Trash2, X, type LucideIcon,
} from 'lucide-react'
import { store, useStore } from '../model/store'
import { type AXTask, type Condition, type Phase, phaseColor, phaseLabel, shortImage } from '../model/resources'
import { Empty, PhaseBadge, PhaseIcon, since } from '../components'
import { TaskLogs } from './TaskLogs'
import '../styles/board.css'

/** State order for sorting: what's live first, what's finished last. */
const STATE_ORDER: Phase[] = ['running', 'pending', 'suspended', 'failed', 'terminating', 'completed']
const stateRank = (p: Phase) => {
  const i = STATE_ORDER.indexOf(p)
  return i < 0 ? STATE_ORDER.length : i
}

type SortKey = 'name' | 'state' | 'workspace' | 'image' | 'worker' | 'age'
type Sort = { key: SortKey; dir: 1 | -1 }

const COLUMNS: { key: SortKey; title: string }[] = [
  { key: 'name', title: 'Name' },
  { key: 'state', title: 'State' },
  { key: 'workspace', title: 'Workspace' },
  { key: 'image', title: 'Image' },
  { key: 'worker', title: 'Worker IP' },
  { key: 'age', title: 'Age' },
]

type MenuState = { task: AXTask; x: number; y: number } | null

/**
 * The task table, sortable by any column (state by default, running on top),
 * plus the inspector that slides in for the selected task. `before` renders
 * above the table, so a page can put its own header there.
 */
export function TaskBoard({ before }: { before?: ReactNode }) {
  const s = useStore()
  const [sort, setSort] = useState<Sort>({ key: 'state', dir: 1 })
  const [menu, setMenu] = useState<MenuState>(null)
  const [confirm, setConfirm] = useState<AXTask | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const tasks = useMemo(() => {
    const created = (t: AXTask) => Date.parse(s.details[t.id]?.createTime ?? '') || 0
    const value = (t: AXTask): string | number => {
      const d = s.details[t.id]
      switch (sort.key) {
        case 'name': return t.name
        case 'state': return stateRank(t.phase)
        case 'workspace': return d?.workspace ?? ''
        case 'image': return d?.image ? shortImage(d.image) : ''
        case 'worker': return t.workerIP ?? ''
        // Newest first reads as "youngest age" ascending.
        case 'age': return -created(t)
      }
    }
    const cmp = (a: string | number, b: string | number) =>
      typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true })
    return [...s.tasks].sort((a, b) => cmp(value(a), value(b)) * sort.dir || stateRank(a.phase) - stateRank(b.phase) || a.name.localeCompare(b.name))
  }, [s.tasks, s.details, sort])

  const onSort = (key: SortKey) => setSort((o) => ({ key, dir: o.key === key ? (-o.dir as 1 | -1) : 1 }))

  return (
    <div className="board-page">
      <div className="board-main">
        {before}
        <div className="row board-head" id="task-board">
          <h2>Tasks</h2>
          {s.tasks.length > 0 && <span className="caption faint">Click a column to sort. Right-click a task for actions.</span>}
        </div>
        {s.tasks.length === 0 ? (
          <div className="card board-empty">
            <Empty icon={Rows3} title="No tasks in this atespace">
              <button className="btn small" style={{ marginTop: 8 }} onClick={() => store.setSection('designer')}>
                <Plus size={12} /> Design a task
              </button>
            </Empty>
          </div>
        ) : (
          <div className="card task-table-wrap">
            <table className="task-table">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className={`col-${c.key} ${sort.key === c.key ? 'sorted' : ''}`}
                      aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                      <button className="th-sort" onClick={() => onSort(c.key)}>
                        {c.title}
                        {sort.key === c.key ? (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : <ArrowUpDown size={11} className="th-idle" />}
                      </button>
                    </th>
                  ))}
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    selected={t.id === s.selectedTaskID}
                    onMenu={(x, y) => setMenu({ task: t, x, y })}
                    onDelete={() => setConfirm(t)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <TaskInspectorPane />

      {menu && (
        <div
          className="menu card fade-in board-menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 160) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {actionsFor(menu.task, () => setConfirm(menu.task)).map((a) => (
            <button
              key={a.label}
              className="menu-item"
              onClick={() => { a.run(); setMenu(null) }}
              style={a.danger ? { color: 'var(--red)' } : undefined}
            >
              <span className="menu-check"><a.icon size={13} /></span>
              {a.label}
            </button>
          ))}
        </div>
      )}

      {confirm && <DeleteTaskModal task={confirm} onClose={() => setConfirm(null)} />}
    </div>
  )
}

/** The selected task's inspector, sliding in from the right of whatever page hosts it. */
export function TaskInspectorPane() {
  const s = useStore()
  const [confirm, setConfirm] = useState<AXTask | null>(null)
  const selected = s.tasks.find((t) => t.id === s.selectedTaskID) ?? null
  return (
    <>
      <aside className={`inspector ${selected ? 'open' : ''}`}>
        {selected && <TaskInspector key={selected.id} task={selected} onDelete={() => setConfirm(selected)} />}
      </aside>
      {confirm && <DeleteTaskModal task={confirm} onClose={() => setConfirm(null)} />}
    </>
  )
}

function DeleteTaskModal({ task, onClose }: { task: AXTask; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal card fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Delete task “{task.name}”?</h3>
        <p className="muted" style={{ margin: '0 0 18px', lineHeight: 1.5 }}>
          Its sandbox is torn down and the task is removed from <strong>{task.atespace}</strong>. This can't be undone.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} autoFocus>Cancel</button>
          <button
            className="btn primary"
            style={{ background: 'var(--red)' }}
            onClick={() => {
              onClose()
              if (store.state.selectedTaskID === task.id) store.set({ selectedTaskID: null })
              void store.remove('task', task.name)
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

interface Action { label: string; icon: LucideIcon; run: () => void; danger?: boolean }

function actionsFor(t: AXTask, onDelete: () => void): Action[] {
  const a: Action[] = []
  if (t.phase === 'suspended' || t.phase === 'failed' || t.phase === 'completed')
    a.push({ label: 'Resume', icon: Play, run: () => void store.resume(t) })
  if (t.phase === 'running' || t.phase === 'pending')
    a.push({ label: 'Suspend', icon: Pause, run: () => void store.suspend(t) })
  if (t.phase === 'running') a.push({ label: 'Terminal', icon: Terminal, run: () => store.openTerminal(t) })
  a.push({ label: 'Delete…', icon: Trash2, run: onDelete, danger: true })
  return a
}

function TaskRow({ task: t, selected, onMenu, onDelete }: {
  task: AXTask
  selected: boolean
  onMenu: (x: number, y: number) => void
  onDelete: () => void
}) {
  const detail = useStore().details[t.id]
  return (
    <tr
      className={`task-row ${selected ? 'selected' : ''}`}
      style={{ '--c': phaseColor(t.phase) } as CSSProperties}
      onClick={() => store.set({ selectedTaskID: selected ? null : t.id })}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <td className="col-name"><span className="task-row-name ellipsis" title={t.name}>{t.name}</span></td>
      <td className="col-state"><PhaseBadge phase={t.phase} /></td>
      <td className="col-workspace">
        {detail?.workspace
          ? <span className="row task-row-ws"><FolderGit2 size={12} color="var(--purple)" /><span className="ellipsis">{detail.workspace}</span></span>
          : <span className="faint">empty /workspace</span>}
      </td>
      <td className="col-image mono ellipsis" title={detail?.image}>{detail?.image ? shortImage(detail.image) : <span className="faint">–</span>}</td>
      <td className="col-worker mono">{t.workerIP ? t.workerIP.split(':')[0] : <span className="faint">–</span>}</td>
      <td className="col-age num" title={detail?.createTime}>{t.age}</td>
      <td className="col-actions">
        <div className="task-row-actions" onClick={(e) => e.stopPropagation()}>
          {actionsFor(t, onDelete).map((a) => (
            <button key={a.label} className={`btn ghost small icon ${a.danger ? 'danger' : ''}`} title={a.label.replace('…', '')} onClick={a.run}>
              <a.icon size={12} />
            </button>
          ))}
        </div>
      </td>
    </tr>
  )
}

// MARK: Inspector

function TaskInspector({ task: t, onDelete }: { task: AXTask; onDelete: () => void }) {
  const detail = useStore().details[t.id]
  const [showManifest, setShowManifest] = useState(false)
  const [copied, setCopied] = useState(false)

  const copyManifest = async () => {
    if (!detail?.manifest) return
    await navigator.clipboard.writeText(detail.manifest)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const fields: [string, string | undefined][] = [
    ['Image', detail?.image],
    ['Command', detail?.command.length ? detail.command.join(' ') : undefined],
    ['Workspace', detail?.workspace ? `${detail.workspace} → /workspace` : 'empty /workspace'],
    ['Resources', detail?.cpu || detail?.memory ? `${detail?.cpu ?? '–'} CPU · ${detail?.memory ?? '–'}` : undefined],
    ['Worker IP', t.workerIP],
    ['Actor', t.actor],
    ['Debug', detail ? (detail.debug ? 'on (guest services for ax ssh)' : 'off') : undefined],
  ]

  return (
    <div className="inspector-inner fade-in">
      <header className="inspector-head">
        <div className="col" style={{ gap: 6, minWidth: 0 }}>
          <strong className="inspector-title ellipsis selectable" title={t.name}>{t.name}</strong>
          <div className="row">
            <PhaseBadge phase={t.phase} />
            <span className="caption faint">{t.atespace} · {t.age}</span>
          </div>
        </div>
        <span className="spacer" />
        <button className="btn ghost icon" title="Close" onClick={() => store.set({ selectedTaskID: null })}><X size={15} /></button>
      </header>

      <div className="inspector-body">
        <LifecycleTrack phase={t.phase} conditions={detail?.conditions ?? []} />

        <div className="row" style={{ flexWrap: 'wrap' }}>
          {actionsFor(t, onDelete).map((a) => (
            <button key={a.label} className={`btn small ${a.danger ? 'danger' : ''}`} onClick={a.run}>
              <a.icon size={12} /> {a.label.replace('…', '')}
            </button>
          ))}
        </div>

        <InspectorSection title="Sandbox">
          <dl className="fields">
            {fields.filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="field">
                <dt>{k}</dt>
                <dd className={k === 'Image' || k === 'Command' || k === 'Worker IP' ? 'mono selectable' : 'selectable'}>{v}</dd>
              </div>
            ))}
          </dl>
        </InspectorSection>

        {!!detail?.conditions.length && (
          <InspectorSection title="Conditions">
            <div className="conditions">
              {detail.conditions.map((c) => {
                const ok = c.status.toLowerCase() === 'true'
                return (
                  <div key={c.type} className="condition">
                    {ok ? <CircleCheck size={15} color="var(--green)" /> : <CircleX size={15} color="#EC835A" />}
                    <div className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
                      <div className="row">
                        <strong>{c.type}</strong>
                        <span className="caption faint">{ok ? 'True' : c.status}</span>
                        <span className="spacer" />
                        {c.updateTime && <span className="caption faint" title={c.updateTime}>{since(c.updateTime)} ago</span>}
                      </div>
                      {c.reason && <span className="caption">{c.reason}</span>}
                      {c.message && <span className="caption muted selectable">{c.message}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </InspectorSection>
        )}

        <InspectorSection title="Logs">
          <TaskLogs task={t} />
        </InspectorSection>

        <section className="inspector-section">
          <div className="row">
            <button className="section-toggle" onClick={() => setShowManifest(!showManifest)}>
              <ChevronRight size={13} className={showManifest ? 'rot' : ''} />
              Manifest
            </button>
            <span className="spacer" />
            <button className="btn small ghost" disabled={!detail?.manifest} title="Copy the manifest as YAML" onClick={copyManifest}>
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {showManifest && <pre className="manifest selectable">{detail?.manifest || 'loading…'}</pre>}
        </section>
      </div>
    </div>
  )
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="inspector-section">
      <h4>{title}</h4>
      {children}
    </section>
  )
}

/** Created → Workspace → Ready, then the current phase if it's terminal or paused. */
function LifecycleTrack({ phase, conditions }: { phase: Phase; conditions: Condition[] }) {
  const find = (type: string) => conditions.find((c) => c.type === type)
  const isTrue = (c?: Condition) => c?.status.toLowerCase() === 'true'
  const ready = find('Ready')
  const ws = find('WorkspaceReady')
  const green = 'var(--green)'
  const stages: { id: string; icon: LucideIcon | null; done: boolean; tint: string; hint?: string }[] = [
    { id: 'Created', icon: Plus, done: true, tint: green },
    { id: 'Workspace', icon: FolderGit2, done: isTrue(ws) || isTrue(ready), tint: green, hint: ws?.reason || ws?.message },
    { id: 'Ready', icon: Bolt, done: isTrue(ready), tint: green, hint: ready?.reason || ready?.message },
  ]
  if (phase !== 'running' && phase !== 'pending') stages.push({ id: phaseLabel(phase), icon: null, done: true, tint: phaseColor(phase) })

  return (
    <div className="lifecycle">
      {stages.map((st, i) => (
        <div key={st.id} className={`stage ${st.done ? 'done' : ''}`} style={{ '--c': st.tint } as CSSProperties} title={st.hint}>
          {i > 0 && <span className={`stage-line ${st.done ? 'done' : ''}`} />}
          <span className="stage-dot">
            {st.icon ? <st.icon size={13} /> : <PhaseIcon phase={phase} size={14} />}
          </span>
          <span className="stage-label">{st.id}</span>
        </div>
      ))}
    </div>
  )
}
