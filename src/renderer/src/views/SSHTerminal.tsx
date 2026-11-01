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

/** Frame the output of a completion request so it can be cut out of the session's output. */
const START = '\x1e'
const END = '\x1f'
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const BUILTINS = ['alias', 'cd', 'echo', 'exit', 'export', 'pwd', 'read', 'set', 'shift', 'trap', 'type', 'umask', 'unset', 'wait']

/**
 * A shell line that prints completions for word, one per line, framed by
 * START and END. It runs in the session's own shell, so paths are relative
 * to its working directory. Directories end in a slash.
 */
function completionLine(word: string, command: boolean) {
  const w = shq(word)
  const paths = `for f in ${w}*; do [ -e "$f" ] || continue; if [ -d "$f" ]; then echo "$f/"; else echo "$f"; fi; done`
  const commands = `(IFS=:; for d in $PATH; do ls -1 "$d"; done) | while read -r c; do case "$c" in ${w}*) echo "$c";; esac; done`
  const body = command && !word.includes('/') && !word.startsWith('.') ? commands : paths
  return `{ printf '\\036'; { ${body}; } 2>/dev/null | sort -u | head -n 500; printf '\\037'; }\n`
}

/** The longest common prefix of words. */
const common = (words: string[]) => words.reduce((a, b) => {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return a.slice(0, i)
})

/** `--shell=<command>` on the command line runs a command in the first session, for screenshots. */
let firstCommand = new URLSearchParams(location.search).get('shell')

/**
 * An in-app shell inside a running task, over `ax ssh <task> -- /bin/sh -i`.
 * ax ssh pipes stdin and stdout rather than allocating a remote terminal, so
 * this is a line-based console: lines are edited here and sent on Enter,
 * which is what a local terminal in cooked mode does too. Tab asks the
 * shell for completions over the same session. Full-screen
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
  // A pending completion request, and the prompts still to come from earlier ones.
  const completing = useRef<{ buf: string; prompt: string; done: (words: string[]) => void } | null>(null)
  const swallow = useRef({ prompt: '', count: 0 })

  useEffect(() => {
    const sid = `ssh-${++sessions}`
    setID(sid)
    setOutput('')
    setStatus('connecting')
    const append = (text: string) => setOutput((o) => (o + text).slice(-MAX_OUTPUT))
    completing.current = null
    swallow.current = { prompt: '', count: 0 }
    const offData = window.studio.onSessionData((d) => {
      if (d.id !== sid) return
      setStatus((st) => (st === 'connecting' ? 'connected' : st))
      let text = clean(d.data)
      // Completion output is never shown. It arrives on stdout; the prompt
      // the shell prints after the hidden command arrives on stderr, in no
      // particular order relative to it, and is dropped too.
      const c = completing.current
      if (c && d.stream === 'stdout') {
        c.buf += text
        const end = c.buf.indexOf(END)
        if (end < 0) return
        const start = c.buf.indexOf(START)
        completing.current = null
        c.done(c.buf.slice(start + 1, end).split('\n').filter(Boolean))
        text = c.buf.slice(end + 1)
      }
      const sw = swallow.current
      if (d.stream === 'stderr') {
        while (sw.count > 0 && sw.prompt && text.startsWith(sw.prompt)) {
          text = text.slice(sw.prompt.length)
          sw.count--
        }
      }
      if (text) append(text)
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

  // The last line is usually the prompt; the input sits right after it.
  const nl = output.lastIndexOf('\n')
  const done = output.slice(0, nl + 1)
  const prompt = output.slice(nl + 1)

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

  const complete = (el: HTMLInputElement) => {
    // Only when the shell is waiting at its prompt; otherwise the request
    // would go to whatever program is reading the input.
    if (completing.current || status !== 'connected' || !/[#$>] $/.test(prompt)) return
    const at = el.selectionStart ?? input.length
    const before = input.slice(0, at)
    const from = before.search(/\S*$/)
    const word = before.slice(from)
    const pre = before.slice(0, from)
    const command = !pre.trim() || /[|;&(]\s*$/.test(pre)
    const shown = prompt
    const timer = setTimeout(() => {
      if (completing.current?.prompt === shown) completing.current = null
    }, 5000)
    swallow.current = { prompt: shown, count: swallow.current.count + 1 }
    completing.current = {
      buf: '',
      prompt: shown,
      done: (found) => {
        clearTimeout(timer)
        const words = [...new Set([...(command ? BUILTINS.filter((b) => b.startsWith(word)) : []), ...found])].sort()
        if (!words.length) return
        const replace = (w: string) => {
          const next = before.slice(0, from) + w + input.slice(at)
          setInput(next)
          const pos = from + w.length
          requestAnimationFrame(() => field.current?.setSelectionRange(pos, pos))
        }
        if (words.length === 1) return replace(words[0] + (words[0].endsWith('/') ? '' : ' '))
        const prefix = common(words)
        if (prefix.length > word.length) return replace(prefix)
        // Nothing more to add: list the candidates, as a shell does.
        const names = words.map((w) => w.replace(/^.*\/(?=.)/, ''))
        const width = Math.max(...names.map((n) => n.length)) + 2
        const perRow = Math.max(1, Math.floor(100 / width))
        const rows: string[] = []
        for (let i = 0; i < names.length; i += perRow) rows.push(names.slice(i, i + perRow).map((n) => n.padEnd(width)).join('').trimEnd())
        pinned.current = true
        setOutput((o) => o + input + '\n' + rows.join('\n') + '\n' + shown)
      },
    }
    void window.studio.writeSession(id, completionLine(word, command))
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const h = history.current
    if (e.key === 'Tab') {
      e.preventDefault()
      complete(e.currentTarget)
    } else if (e.key === 'Enter') {
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
          <span>Line mode · Tab complete · ↑↓ history · Ctrl-C interrupt · Ctrl-D end · Ctrl-L clear</span>
          <span className="spacer" />
          {status === 'exited' && (
            <button className="btn small ghost" onClick={() => setAttempt((a) => a + 1)}><RotateCcw size={12} /> Reconnect</button>
          )}
        </div>
      </div>
    </div>
  )
}
