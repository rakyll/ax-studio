import { useEffect, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import {
  Bolt, Check, ChevronRight, CircleCheck, CircleX, Columns3, Copy, FolderGit2, Network, Pause, Play,
  Plus, Terminal, Trash2, X, type LucideIcon,
} from 'lucide-react'
import { store, useStore } from '../model/store'
import { type AXTask, type Condition, type Phase, PHASES, comparePhase, phaseColor, phaseLabel, shortImage } from '../model/resources'
import { Chip, Empty, PhaseBadge, PhaseIcon, since } from '../components'
import { TaskLogs } from './TaskLogs'
import '../styles/board.css'

const ALWAYS: Phase[] = ['pending', 'running', 'suspended', 'failed']
const DROP_TARGETS: Phase[] = ['running', 'suspended']

type MenuState = { task: AXTask; x: number; y: number } | null

/**
 * The task board: phase columns you drag cards between, plus the inspector
 * that slides in for the selected task. `before` renders above the columns,
 * so a page can put its own header there.
 */
export function TaskBoard({ before }: { before?: ReactNode }) {
  const s = useStore()
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<Phase | null>(null)
  const [menu, setMenu] = useState<MenuState>(null)
  const [confirm, setConfirm] = useState<AXTask | null>(null)

  const present = new Set(s.tasks.map((t) => t.phase))
  const phases = [...new Set([...ALWAYS, ...PHASES.filter((p) => present.has(p)), ...present])].sort(comparePhase)
  const selected = s.tasks.find((t) => t.id === s.selectedTaskID) ?? null
  const draggedTask = s.tasks.find((t) => t.name === dragging)

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

  const canDrop = (p: Phase) => !!draggedTask && DROP_TARGETS.includes(p) && draggedTask.phase !== p

  const onDrop = (p: Phase) => (e: DragEvent) => {
    e.preventDefault()
    const name = e.dataTransfer.getData('text/plain')
    const t = s.tasks.find((x) => x.name === name)
    setDragging(null)
    setOver(null)
    if (!t || t.phase === p) return
    if (p === 'running') void store.resume(t)
    else if (p === 'suspended') void store.suspend(t)
  }

  return (
    <div className="board-page">
      <div className="board-main">
        {before}
        <div className="row board-head" id="task-board">
          <h2>Tasks</h2>
          {s.tasks.length > 0 && <span className="caption faint">Drag a card onto Running or Suspended to resume or suspend it.</span>}
        </div>
        {s.tasks.length === 0 ? (
          <div className="card board-empty">
            <Empty icon={Columns3} title="No tasks in this atespace">
              <button className="btn small" style={{ marginTop: 8 }} onClick={() => store.setSection('designer')}>
                <Plus size={12} /> Design a task
              </button>
            </Empty>
          </div>
        ) : (
          <div className="board-columns">
            {phases.map((p) => {
              const tasks = s.tasks.filter((t) => t.phase === p)
              const droppable = canDrop(p)
              return (
                <section
                  key={p}
                  className={`board-col ${dragging ? (droppable ? 'can-drop' : 'no-drop') : ''} ${over === p && droppable ? 'over' : ''}`}
                  style={{ '--c': phaseColor(p) } as CSSProperties}
                  onDragOver={(e) => {
                    if (!droppable) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (over !== p) setOver(p)
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === p ? null : o))
                  }}
                  onDrop={onDrop(p)}
                >
                  <header className="board-col-head">
                    <PhaseIcon phase={p} />
                    <span className="board-col-title">{phaseLabel(p)}</span>
                    <span className="board-col-count">{tasks.length}</span>
                  </header>
                  <div className="board-col-body">
                    {tasks.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        selected={t.id === s.selectedTaskID}
                        dragging={dragging === t.name}
                        onDragStart={() => setDragging(t.name)}
                        onDragEnd={() => { setDragging(null); setOver(null) }}
                        onMenu={(x, y) => setMenu({ task: t, x, y })}
                        onDelete={() => setConfirm(t)}
                      />
                    ))}
                    {p === 'pending' ? (
                      <button className="board-col-new" onClick={() => store.setSection('designer')} title="Design a new task in the Designer">
                        <Plus size={13} />New task in Designer
                      </button>
                    ) : tasks.length === 0 && (
                      <div className="board-col-empty">
                        {droppable ? `Drop to ${p === 'running' ? 'resume' : 'suspend'}` : 'No tasks'}
                      </div>
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>

      <aside className={`inspector ${selected ? 'open' : ''}`}>
        {selected && <TaskInspector key={selected.id} task={selected} onDelete={() => setConfirm(selected)} />}
      </aside>

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

      {confirm && (
        <div className="modal-backdrop" onMouseDown={() => setConfirm(null)}>
          <div className="modal card fade-in" onMouseDown={(e) => e.stopPropagation()}>
            <h3>Delete task “{confirm.name}”?</h3>
            <p className="muted" style={{ margin: '0 0 18px', lineHeight: 1.5 }}>
              Its sandbox is torn down and the task is removed from <strong>{confirm.atespace}</strong>. This can't be undone.
            </p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setConfirm(null)} autoFocus>Cancel</button>
              <button
                className="btn primary"
                style={{ background: 'var(--red)' }}
                onClick={() => {
                  const t = confirm
                  setConfirm(null)
                  if (store.state.selectedTaskID === t.id) store.set({ selectedTaskID: null })
                  void store.remove('task', t.name)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
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
  if (t.phase === 'running') a.push({ label: 'Open Shell', icon: Terminal, run: () => store.openShell(t) })
  a.push({ label: 'Delete…', icon: Trash2, run: onDelete, danger: true })
  return a
}

function TaskCard({ task: t, selected, dragging, onDragStart, onDragEnd, onMenu, onDelete }: {
  task: AXTask
  selected: boolean
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onMenu: (x: number, y: number) => void
  onDelete: () => void
}) {
  const detail = useStore().details[t.id]
  return (
    <div
      className={`task-card card ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''}`}
      style={{ '--c': phaseColor(t.phase) } as CSSProperties}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', t.name)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={() => store.set({ selectedTaskID: selected ? null : t.id })}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    >
      <div className="task-card-top">
        <span className="task-card-name ellipsis" title={t.name}>{t.name}</span>
        <div className="task-card-actions" onClick={(e) => e.stopPropagation()}>
          {actionsFor(t, onDelete).map((a) => (
            <button key={a.label} className={`btn ghost small icon ${a.danger ? 'danger' : ''}`} title={a.label.replace('…', '')} onClick={a.run}>
              <a.icon size={12} />
            </button>
          ))}
        </div>
      </div>
      <div className="task-card-meta">
        <PhaseBadge phase={t.phase} />
        {detail?.workspace ? <Chip icon={FolderGit2} title="Workspace">{detail.workspace}</Chip> : <Chip title="No workspace">empty /workspace</Chip>}
      </div>
      <div className="task-card-foot">
        {detail?.image && <span className="mono ellipsis" title={detail.image}>{shortImage(detail.image)}</span>}
        <span className="spacer" />
        {t.workerIP && <span className="mono" title="Worker IP"><Network size={10} /> {t.workerIP.split(':')[0]}</span>}
        <span title="Age">{t.age}</span>
      </div>
    </div>
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
