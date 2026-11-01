import { SquareTerminal, X } from 'lucide-react'
import { store, useStore, type SSHTab } from '../model/store'
import { comparePhase, phaseLabel, type AXTask } from '../model/resources'
import { Empty, PageHeader, PhaseIcon } from '../components'
import { SSHTerminal } from './SSHTerminal'
import '../styles/ssh.css'

/** Tab labels: the task name, numbered when a task has more than one session. */
function tabLabel(tab: SSHTab, tabs: SSHTab[]) {
  const same = tabs.filter((x) => x.task.id === tab.task.id && x.context === tab.context)
  return same.length > 1 ? `${tab.task.name} (${same.indexOf(tab) + 1})` : tab.task.name
}

/**
 * Terminals into running tasks. The page stays mounted while it has tabs,
 * so sessions keep running when you switch to another page.
 */
export function SSH() {
  const s = useStore()
  const tasks = [...s.tasks].sort((a, b) => comparePhase(a.phase, b.phase) || a.name.localeCompare(b.name))
  const openIDs = new Set(s.sshTabs.filter((x) => x.context === s.context).map((x) => x.task.id))

  return (
    <div className="ssh-page">
      <div className="ssh-head">
        <PageHeader title="SSH" subtitle={<>Terminals into running tasks over <code>ax ssh</code>.</>} />
      </div>
      <div className="ssh-layout">
        <aside className="card ssh-tasks">
          <div className="ssh-tasks-head caption faint">Tasks in {s.atespace}</div>
          {tasks.length === 0 && <p className="caption faint ssh-none">No tasks in this atespace.</p>}
          {tasks.map((t) => <TaskRow key={t.id} t={t} open={openIDs.has(t.id)} debugOff={s.details[t.id]?.debug === false} />)}
        </aside>
        <section className="card ssh-main">
          {s.sshTabs.length > 0 && (
            <div className="ssh-tabs" role="tablist">
              {s.sshTabs.map((tab) => (
                <div key={tab.key} role="tab" aria-selected={tab.key === s.sshActive}
                  className={`ssh-tab ${tab.key === s.sshActive ? 'on' : ''}`} title={`${tab.task.name} · ${tab.context}`}
                  onMouseDown={(e) => {
                    if (e.button === 1) store.closeShell(tab.key)
                    else store.set({ sshActive: tab.key })
                  }}>
                  <SquareTerminal size={13} />
                  <span>{tabLabel(tab, s.sshTabs)}</span>
                  {tab.context !== s.context && <span className="faint">· {tab.context}</span>}
                  <button className="btn icon ghost ssh-tab-close" title="Close session"
                    onMouseDown={(e) => e.stopPropagation()} onClick={() => store.closeShell(tab.key)}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {s.sshTabs.map((tab) => <SSHTerminal key={tab.key} tab={tab} active={tab.key === s.sshActive} />)}
          {s.sshTabs.length === 0 && (
            <div className="ssh-empty">
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
    <button className={`ssh-task ${open ? 'open' : ''}`} disabled={!running} onClick={() => store.openShell(t)}
      title={running ? (open ? 'Show its terminal' : 'Open a terminal') : `${phaseLabel(t.phase)}: only running tasks take ssh`}>
      <PhaseIcon phase={t.phase} size={13} />
      <span className="ssh-task-name">{t.name}</span>
      {running && debugOff && <span className="caption ssh-task-note" title="Debug is off, so ax ssh may not connect">debug off</span>}
      {!running && <span className="caption faint">{phaseLabel(t.phase)}</span>}
      {open && <span className="ssh-task-dot" />}
    </button>
  )
}
