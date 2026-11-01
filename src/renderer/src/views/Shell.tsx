import { SquareTerminal, X } from 'lucide-react'
import { store, useStore, type ShellTab } from '../model/store'
import { comparePhase, phaseLabel, type AXTask } from '../model/resources'
import { Empty, PageHeader, PhaseIcon } from '../components'
import { ShellTerminal } from './ShellTerminal'
import '../styles/shell.css'

/** Tab labels: the task name, numbered when a task has more than one session. */
function tabLabel(tab: ShellTab, tabs: ShellTab[]) {
  const same = tabs.filter((x) => x.task.id === tab.task.id && x.context === tab.context)
  return same.length > 1 ? `${tab.task.name} (${same.indexOf(tab) + 1})` : tab.task.name
}

/**
 * Terminals into running tasks. The page stays mounted while it has tabs,
 * so sessions keep running when you switch to another page.
 */
export function Shell() {
  const s = useStore()
  const tasks = [...s.tasks].sort((a, b) => comparePhase(a.phase, b.phase) || a.name.localeCompare(b.name))
  const openIDs = new Set(s.shellTabs.filter((x) => x.context === s.context).map((x) => x.task.id))

  return (
    <div className="shell-page">
      <div className="shell-head">
        <PageHeader title="Shell" subtitle={<>Terminals into running tasks over <code>ax ssh</code>.</>} />
      </div>
      <div className="shell-layout">
        <aside className="card shell-tasks">
          <div className="shell-tasks-head caption faint">Tasks in {s.atespace}</div>
          {tasks.length === 0 && <p className="caption faint shell-none">No tasks in this atespace.</p>}
          {tasks.map((t) => <TaskRow key={t.id} t={t} open={openIDs.has(t.id)} debugOff={s.details[t.id]?.debug === false} />)}
        </aside>
        <section className="card shell-main">
          {s.shellTabs.length > 0 && (
            <div className="shell-tabs" role="tablist">
              {s.shellTabs.map((tab) => (
                <div key={tab.key} role="tab" aria-selected={tab.key === s.shellActive}
                  className={`shell-tab ${tab.key === s.shellActive ? 'on' : ''}`} title={`${tab.task.name} · ${tab.context}`}
                  onMouseDown={(e) => {
                    if (e.button === 1) store.closeShell(tab.key)
                    else store.set({ shellActive: tab.key })
                  }}>
                  <SquareTerminal size={13} />
                  <span>{tabLabel(tab, s.shellTabs)}</span>
                  {tab.context !== s.context && <span className="faint">· {tab.context}</span>}
                  <button className="btn icon ghost shell-tab-close" title="Close session"
                    onMouseDown={(e) => e.stopPropagation()} onClick={() => store.closeShell(tab.key)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {s.shellTabs.map((tab) => <ShellTerminal key={tab.key} tab={tab} active={tab.key === s.shellActive} />)}
          {s.shellTabs.length === 0 && (
            <div className="shell-empty">
              <Empty icon={SquareTerminal} title="No open sessions">
                <span className="caption">Pick a running task to open a shell in its sandbox.</span>
              </Empty>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function TaskRow({ t, open, debugOff }: { t: AXTask; open: boolean; debugOff: boolean }) {
  const running = t.phase === 'running'
  return (
    <button className={`shell-task ${open ? 'open' : ''}`} disabled={!running} onClick={() => store.openShell(t)}
      title={running ? (open ? 'Show its terminal' : 'Open a terminal') : `${phaseLabel(t.phase)}: only running tasks have a shell`}>
      <PhaseIcon phase={t.phase} size={13} />
      <span className="shell-task-name">{t.name}</span>
      {running && debugOff && <span className="caption shell-task-note" title="Debug is off, so ax ssh may not connect">debug off</span>}
      {!running && <span className="caption faint">{phaseLabel(t.phase)}</span>}
      {open && <span className="shell-task-dot" />}
    </button>
  )
}
