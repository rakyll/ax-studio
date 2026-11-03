import { useState } from 'react'
import { Circle, CircleCheck, CircleX, LoaderCircle } from 'lucide-react'
import { Toggle } from '../components'
import { moveSteps, moveTask, type MoveStep } from '../model/move'
import { shortName, validateLabel, type AXTask } from '../model/resources'
import { store, useStore } from '../model/store'

/** Moves a task to another cluster or atespace, showing each step as it runs. */
export function MoveTaskModal({ task: t, onClose }: { task: AXTask; onClose: () => void }) {
  const s = useStore()
  const others = s.contexts.filter((c) => c.name !== s.context)
  const [context, setContext] = useState(others[0]?.name ?? s.context)
  const [atespace, setAtespace] = useState(s.atespace || 'default')
  const [deleteOriginal, setDeleteOriginal] = useState(false)
  const [steps, setSteps] = useState<MoveStep[] | null>(null)
  const [outcome, setOutcome] = useState<boolean | null>(null)
  const debug = s.details[t.id]?.debug
  const running = steps !== null && outcome === null
  const same = context === s.context && (atespace || 'default') === (s.atespace || 'default')
  const atespaceError = atespace ? validateLabel(atespace) : null
  const to = { context, atespace }

  const start = async () => {
    setSteps(moveSteps(to, deleteOriginal))
    setOutcome(await moveTask(t, to, deleteOriginal, setSteps))
  }

  const show = async () => {
    onClose()
    store.setScope({ context, atespace: atespace || 'default' })
    await store.refresh(true)
    const moved = store.state.tasks.find((x) => x.name === t.name)
    if (moved) store.set({ selectedTaskID: moved.id })
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => !running && onClose()}>
      <div className="modal card fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Move “{t.name}”</h3>
        <p className="muted" style={{ margin: '0 0 16px', lineHeight: 1.5 }}>
          The task is recreated at the destination and its workspace files are copied over. Running processes
          restart there; anything only in memory is lost, as with suspend and resume.
        </p>
        {steps === null ? (
          <div className="form-grid">
            <label>Context</label>
            <select className="select" value={context} onChange={(e) => setContext(e.target.value)}>
              {s.contexts.map((c) => (
                <option key={c.name} value={c.name}>{shortName(c.name)}{c.name === s.context ? ' (current)' : ''}</option>
              ))}
            </select>
            <label>Atespace</label>
            <input className={`input ${atespaceError ? 'invalid' : ''}`} value={atespace} placeholder="default"
              onChange={(e) => setAtespace(e.target.value)} title={atespaceError ?? undefined} />
            <label>Delete original</label>
            <div className="row">
              <Toggle checked={deleteOriginal} onChange={setDeleteOriginal} />
              <span className="caption faint">{deleteOriginal ? 'Deleted once the copy is running' : 'Left suspended'}</span>
            </div>
          </div>
        ) : (
          <ol className="move-steps">
            {steps.map((st) => (
              <li key={st.title} className={`move-step ${st.state}`}>
                {st.state === 'done' ? <CircleCheck size={14} color="var(--green)" />
                  : st.state === 'failed' ? <CircleX size={14} color="var(--red)" />
                  : st.state === 'running' ? <LoaderCircle size={14} className="spin" />
                  : <Circle size={14} className="faint" />}
                <span className="col" style={{ minWidth: 0 }}>
                  <span>{st.title}</span>
                  {st.detail && <span className={`caption ${st.state === 'failed' ? '' : 'faint'} selectable`}
                    style={st.state === 'failed' ? { color: 'var(--red)' } : undefined}>{st.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
        {steps === null && debug === false && (
          <p className="caption" style={{ color: 'var(--red)', margin: '14px 0 0' }}>
            This task has debug off, so ax ssh can't reach it to copy files. Re-apply it with debug: true first.
          </p>
        )}
        {steps === null && same && <p className="caption faint" style={{ margin: '14px 0 0' }}>Pick another context or atespace.</p>}
        <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
          {steps === null ? (
            <>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={same || !!atespaceError || debug === false} onClick={() => void start()}>Move</button>
            </>
          ) : (
            <>
              <button className="btn" disabled={running} onClick={onClose}>Close</button>
              {outcome && <button className="btn primary" onClick={() => void show()}>Show in {shortName(context)}</button>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
