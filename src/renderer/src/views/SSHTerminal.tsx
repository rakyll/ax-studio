import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ExternalLink, RotateCcw, X } from 'lucide-react'
import { store, useStore } from '../model/store'
import type { AXTask } from '../model/resources'

/** Characters of scrollback kept. */
const MAX_OUTPUT = 200_000
let sessions = 0

/** Drops ANSI escapes and carriage returns: the session has no terminal to interpret them. */
const clean = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').replace(/\r\n?/g, '\n')
  // Expected without a terminal, and not something the user can act on.
  .replace(/^.*can't access tty; job control turned off\n?/m, '')

/** `--shell=<command>` on the command line runs a command in the first session, for screenshots. */
let firstCommand = new URLSearchParams(location.search).get('shell')

/**
 * An in-app shell inside a running task, over `ax ssh <task> -- /bin/sh -i`.
 * ax ssh pipes stdin and stdout rather than allocating a remote terminal, so
 * this is a line-based console: lines are edited here and sent on Enter,
 * which is what a local terminal in cooked mode does too. Full-screen
 * programs like vim or top need a real terminal; use "Open in Terminal".
 */
export function SSHTerminal({ task: t }: { task: AXTask }) {
  const s = useStore()
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState<'connecting' | 'connected' | 'exited'>('connecting')
  const [exitCode, setExitCode] = useState(0)
  const [input, setInput] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [id, setID] = useState('')
  const history = useRef<string[]>([])
  const back = useRef(-1)
  const box = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const sid = `ssh-${++sessions}`
    setID(sid)
    setOutput('')
    setStatus('connecting')
    const append = (text: string) => setOutput((o) => (o + text).slice(-MAX_OUTPUT))
    const offData = window.studio.onSessionData((d) => {
      if (d.id !== sid) return
      setStatus((st) => (st === 'connecting' ? 'connected' : st))
      append(clean(d.data))
      if (firstCommand) {
        append(firstCommand + '\n')
        void window.studio.writeSession(sid, firstCommand + '\n')
        firstCommand = null
      }
    })
    const offExit = window.studio.onSessionExit((e) => {
      if (e.id !== sid) return
      setStatus('exited')
      setExitCode(e.status)
    })
    void window.studio.startSession({ id: sid, program: s.settings.axPath, args: store.sshArgs(t, ['/bin/sh', '-i']) })
    return () => {
      offData()
      offExit()
      void window.studio.closeSession(sid)
    }
  }, [t.name, t.atespace, s.context, s.settings.axPath, attempt])

  useEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [output])

  useEffect(() => field.current?.focus(), [status])

  const send = () => {
    const line = input
    setInput('')
    back.current = -1
    if (line.trim() && history.current[history.current.length - 1] !== line) history.current.push(line)
    if (line.trim() === 'clear') {
      setOutput('')
      void window.studio.writeSession(id, '\n')
      return
    }
    // The remote shell doesn't echo: show the line as a terminal would.
    setOutput((o) => o + line + '\n')
    pinned.current = true
    void window.studio.writeSession(id, line + '\n')
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const h = history.current
    if (e.key === 'Enter') {
      e.preventDefault()
      send()
    } else if (e.key === 'ArrowUp' && h.length) {
      e.preventDefault()
      back.current = back.current < 0 ? h.length - 1 : Math.max(0, back.current - 1)
      setInput(h[back.current])
    } else if (e.key === 'ArrowDown' && back.current >= 0) {
      e.preventDefault()
      back.current = back.current + 1 < h.length ? back.current + 1 : -1
      setInput(back.current < 0 ? '' : h[back.current])
    } else if (e.ctrlKey && e.key === 'c') {
      e.preventDefault()
      setOutput((o) => o + input + '^C\n')
      setInput('')
      void window.studio.interruptSession(id)
    } else if (e.ctrlKey && e.key === 'd' && !input) {
      e.preventDefault()
      void window.studio.endSessionInput(id)
    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault()
      setOutput((o) => o.slice(o.lastIndexOf('\n') + 1))
    }
  }

  // The last line is usually the prompt; the input sits right after it.
  const nl = output.lastIndexOf('\n')
  const done = output.slice(0, nl + 1)
  const prompt = output.slice(nl + 1)

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && store.closeShell()}>
      <div className="card term-modal">
        <div className="row term-title">
          <span className={`pulse ${status === 'connected' ? 'on' : ''}`}
            style={{ '--c': status === 'connected' ? 'var(--green)' : status === 'exited' ? 'var(--text-3)' : 'var(--orange)' } as CSSProperties} />
          <strong>{t.name}</strong>
          <span className="faint mono">ax ssh · {s.context}</span>
          <span className="spacer" />
          <button className="btn small ghost" title="Open in your terminal app" onClick={() => void store.openExternalShell(t)}>
            <ExternalLink size={12} /> Open in Terminal
          </button>
          <button className="btn icon ghost" title="Close" onClick={() => store.closeShell()}><X size={15} /></button>
        </div>
        <div
          ref={box}
          className="term-body selectable"
          onMouseUp={() => !window.getSelection()?.toString() && field.current?.focus()}
          onScroll={(e) => {
            const el = e.currentTarget
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {s.details[t.id]?.debug === false && (
            <div className="term-note">Debug is off for this task, so ax ssh may not connect. Turn on Debug in the Designer and re-apply.</div>
          )}
          {status === 'connecting' && !output && <div className="term-note">Connecting to {t.name}…</div>}
          <span>{done}</span>
          {status !== 'exited' ? (
            <div className="term-line">
              <span>{prompt}</span>
              <input
                ref={field}
                className="term-input"
                value={input}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKey}
              />
            </div>
          ) : (
            <>
              <span>{prompt}</span>
              <div className="term-note">Session ended{exitCode ? ` (exit ${exitCode})` : ''}.</div>
            </>
          )}
        </div>
        <div className="row term-foot caption faint">
          <span>Line mode · ↑↓ history · Ctrl-C interrupt · Ctrl-D end · Ctrl-L clear</span>
          <span className="spacer" />
          {status === 'exited' && (
            <button className="btn small ghost" onClick={() => setAttempt((a) => a + 1)}><RotateCcw size={12} /> Reconnect</button>
          )}
        </div>
      </div>
    </div>
  )
}
