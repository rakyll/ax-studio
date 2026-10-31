import { Fragment, type ReactNode } from 'react'

type Tok = { cls: string; text: string }

/** Value part of a line: strings, numbers/bools/null, flow brackets, trailing comments. */
function value(s: string): Tok[] {
  const out: Tok[] = []
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')|(\s#.*$)|(\b(?:true|false|null|yes|no)\b|-?\b\d+(?:\.\d+)?\b)|([[\]{},])|([^"'#[\]{},\s]+|\s+|.)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m[1]) out.push({ cls: 'y-str', text: m[1] })
    else if (m[2]) out.push({ cls: 'y-comment', text: m[2] })
    else if (m[3]) out.push({ cls: 'y-num', text: m[3] })
    else if (m[4]) out.push({ cls: 'y-punct', text: m[4] })
    else if (/^\s*[|>][-+]?\s*$/.test(m[0])) out.push({ cls: 'y-punct', text: m[0] })
    else out.push({ cls: 'y-plain', text: m[0] })
  }
  return out
}

/** A tiny line-oriented YAML highlighter; good enough for manifests. */
export function tokenizeYAML(text: string): Tok[][] {
  const lines = text.replace(/\n$/, '').split('\n')
  let blockIndent = -1
  return lines.map((line) => {
    const indent = line.length - line.trimStart().length
    if (blockIndent >= 0) {
      if (!line.trim() || indent > blockIndent) return [{ cls: 'y-block', text: line }]
      blockIndent = -1
    }
    if (/^---\s*$/.test(line)) return [{ cls: 'y-sep', text: line }]
    if (/^\s*#/.test(line)) return [{ cls: 'y-comment', text: line }]
    const toks: Tok[] = []
    let rest = line
    const lead = /^(\s*)(- )?/.exec(rest)!
    if (lead[1]) toks.push({ cls: '', text: lead[1] })
    if (lead[2]) toks.push({ cls: 'y-punct', text: lead[2] })
    rest = rest.slice(lead[0].length)
    const key = /^([A-Za-z0-9_.\-/"']+)(:)(\s|$)/.exec(rest)
    if (key) {
      toks.push({ cls: 'y-key', text: key[1] }, { cls: 'y-punct', text: key[2] })
      rest = rest.slice(key[1].length + 1)
      if (/^\s*[|>][-+]?\s*$/.test(rest)) blockIndent = indent + (lead[2] ? 2 : 0)
    }
    toks.push(...value(rest))
    return toks
  })
}

export function YamlView({ text }: { text: string }) {
  const lines = tokenizeYAML(text)
  return (
    <div className="yaml-view selectable">
      <div className="yaml-gutter" aria-hidden>
        {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <pre className="yaml-code">
        {lines.map((toks, i) => (
          <div key={i} className="yaml-line">
            {toks.length === 0 ? '​' : toks.map((t, j): ReactNode => <Fragment key={j}>{t.cls ? <span className={t.cls}>{t.text}</span> : t.text}</Fragment>)}
          </div>
        ))}
      </pre>
    </div>
  )
}
