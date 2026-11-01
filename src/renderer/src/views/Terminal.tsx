import { SquareTerminal, X } from 'lucide-react'
import { store, useStore, type TerminalTab } from '../model/store'
import { comparePhase, phaseLabel, type AXTask } from '../model/resources'
import { Empty, PageHeader, PhaseIcon } from '../components'
import { TerminalSession } from './TerminalSession'
import '../styles/terminal.css'

/** Tab labels: the task name, numbered when a task has more than one session. */
function tabLabel(tab: TerminalTab, tabs: TerminalTab[]) {
  const same = tabs.filter((x) => x.task.id === tab.task.id && x.context === tab.context)
  return same.length > 1 ? `${tab.task.name} (${same.indexOf(tab) + 1})` : tab.task.name
}

/**
 * Terminals into running tasks. The page stays mounted while it has tabs,
 * so sessions keep running when you switch to another page.
 */
export function TerminalPage() {
  const s = useStore()
  const tasks = [...s.tasks].sort((a, b) => comparePhase(a.phase, b.phase) || a.name.localeCompare(b.name))
  const openIDs = new Set(s.terminalTabs.filter((x) => x.context === s.context).map((x) => x.task.id))

  return (
    <div className="terminal-page">
      <div className="terminal-head">
        <PageHeader title="Terminal" subtitle={<>Terminals into running tasks over <code>ax ssh</code>.</>} />
      </div>
      <div className="terminal-layout">
        <aside className="card terminal-tasks">
          <div className="terminal-tasks-head caption faint">Tasks in {s.atespace}</div>
          {tasks.length === 0 && <p className="caption faint terminal-none">No tasks in this atespace.</p>}
          {tasks.map((t) => <TaskRow key={t.id} t={t} open={openIDs.has(t.id)} debugOff={s.details[t.id]?.debug === false} />)}
        </aside>
        <section className="card terminal-main">
          {s.terminalTabs.length > 0 && (
            <div className="terminal-tabs" role="tablist">
              {s.terminalTabs.map((tab) => (
                <div key={tab.key} role="tab" aria-selected={tab.key === s.terminalActive}
                  className={`terminal-tab ${tab.key === s.terminalActive ? 'on' : ''}`} title={`${tab.task.name} · ${tab.context}`}
                  onMouseDown={(e) => {
                    if (e.button === 1) store.closeTerminal(tab.key)
                    else store.set({ terminalActive: tab.key })
                  }}>
                  <SquareTerminal size={13} />
                  <span>{tabLabel(tab, s.terminalTabs)}</span>
                  {tab.context !== s.context && <span className="faint">· {tab.context}</span>}
                  <button className="btn icon ghost terminal-tab-close" title="Close session"
                    onMouseDown={(e) => e.stopPropagation()} onClick={() => store.closeTerminal(tab.key)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {s.terminalTabs.map((tab) => <TerminalSession key={tab.key} tab={tab} active={tab.key === s.terminalActive} />)}
          {s.terminalTabs.length === 0 && (
            <div className="terminal-empty">
              <Empty icon={SquareTerminal} title="No open sessions">
                <span className="caption">Pick a running task to open a terminal in its sandbox.</span>
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
    <button className={`terminal-task ${open ? 'open' : ''}`} disabled={!running} onClick={() => store.openTerminal(t)}
      title={running ? (open ? 'Show its terminal' : 'Open a terminal') : `${phaseLabel(t.phase)}: only running tasks have a terminal`}>
      <PhaseIcon phase={t.phase} size={13} />
      <span className="terminal-task-name">{t.name}</span>
      {running && debugOff && <span className="caption terminal-task-note" title="Debug is off, so ax ssh may not connect">debug off</span>}
      {!running && <span className="caption faint">{phaseLabel(t.phase)}</span>}
      {open && <span className="terminal-task-dot" />}
    </button>
  )
}
