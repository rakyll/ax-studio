import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  ChevronRight, CircleCheck, CircleX, Container, Database, Layers3, Loader, MinusCircle, Network, Package, Play,
  Server, ShieldCheck, Square, Square as SquareIcon, SquareCheck as CheckSquare, Terminal, TriangleAlert, Circle, type LucideIcon,
} from 'lucide-react'
import { deploy, useDeploy, type Arch, type DeployStep } from '../model/deploy'
import { PageHeader, Toggle } from '../components'
import '../styles/deploy.css'

const ARCHES: Arch[] = ['amd64', 'arm64']

const ICONS: Record<string, LucideIcon> = {
  container: Container, terminal: Terminal, server: Server, play: Play, network: Network,
  layers: Layers3, package: Package, database: Database, shield: ShieldCheck,
}

export function Deploy() {
  const d = useDeploy()
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => void deploy.init(), [])
  const problems = deploy.problems

  return (
    <div className="deploy">
      <div className="deploy-top">
        <PageHeader title="Deploy" subtitle="Bring up AX on a Kubernetes cluster, step by step.">
          {d.running ? (
            <button className="btn" onClick={() => deploy.cancel()}><Square size={12} />Stop</button>
          ) : (
            <button className="btn primary" disabled={problems.length > 0 || !d.steps.some((s) => s.enabled)} onClick={() => void deploy.runAll()}>
              <Play size={13} fill="currentColor" />Run pipeline
            </button>
          )}
        </PageHeader>

        <div className="row deploy-config">
          <label className="field">
            <span>Context</span>
            <select className="select" value={d.kubeContext} onChange={(e) => deploy.set({ kubeContext: e.target.value }, true)}>
              {d.kubeContexts.length === 0 && <option value="">no kubectl contexts</option>}
              {d.kubeContexts.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="field grow">
            <span>Image registry</span>
            <input className="input mono" placeholder="us-docker.pkg.dev/project/repo" value={d.imageRepo}
              onChange={(e) => deploy.set({ imageRepo: e.target.value }, true)} />
          </label>
          <div className="field">
            <span>Arch</span>
            <div className="arch-picks">
              {ARCHES.map((a) => {
                const on = d.arches.includes(a)
                return (
                  <button key={a} className={`arch-pick ${on ? 'on' : ''}`} aria-pressed={on} title={`Build linux/${a} images`}
                    onClick={() => deploy.set({ arches: on ? d.arches.filter((x) => x !== a) : ARCHES.filter((x) => x === a || d.arches.includes(x)) }, true)}>
                    {on ? <CheckSquare size={13} /> : <SquareIcon size={13} />}{a}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="pipeline">
          {d.steps.map((s, i) => (
            <div key={s.id} className="row pipe-item">
              {i > 0 && <Connector from={d.steps[i - 1]} to={s} />}
              <StepCard step={s} index={i} selected={selected === s.id}
                onSelect={() => setSelected(selected === s.id ? null : s.id)} />
            </div>
          ))}
        </div>

        {problems.map((p) => (
          <div key={p} className="row problem-line"><TriangleAlert size={14} />{p}</div>
        ))}
      </div>
      <Console filter={selected} onClear={() => setSelected(null)} />
    </div>
  )
}

function stateView(s: DeployStep): { icon: LucideIcon; color: string; label: string } {
  if (!s.enabled && s.state.kind !== 'running') return { icon: MinusCircle, color: 'var(--text-3)', label: 'Skipped' }
  switch (s.state.kind) {
    case 'running': return { icon: Loader, color: 'var(--accent)', label: 'Running…' }
    case 'ok': return { icon: CircleCheck, color: 'var(--green)', label: s.duration ? `Done · ${s.duration.toFixed(1)}s` : 'Done' }
    case 'failed': return { icon: CircleX, color: 'var(--red)', label: `Failed · exit ${s.state.status}` }
    case 'skipped': return { icon: MinusCircle, color: 'var(--text-3)', label: 'Skipped' }
    default: return { icon: Circle, color: 'var(--text-3)', label: 'Ready' }
  }
}

function StepCard({ step, index, selected, onSelect }: { step: DeployStep; index: number; selected: boolean; onSelect: () => void }) {
  const d = useDeploy()
  const Icon = ICONS[step.icon] ?? Terminal
  const st = stateView(step)
  const tint = step.state.kind === 'failed' ? 'var(--red)' : step.state.kind === 'ok' ? 'var(--green)' : 'var(--accent)'
  return (
    <div
      className={`card step ${selected ? 'highlight' : ''} ${step.state.kind} ${step.enabled ? '' : 'off'}`}
      style={{ '--tint': tint } as CSSProperties}
      onClick={onSelect}
      title={`$ ${step.command}`}
    >
      <div className="row">
        <div className="step-icon"><Icon size={16} /></div>
        <span className="step-index">{index + 1}</span>
        <div className="spacer" />
        <span onClick={(e) => e.stopPropagation()}>
          <Toggle checked={step.enabled} onChange={(v) => deploy.toggle(step.id, v)} title="Include in pipeline" />
        </span>
      </div>
      <div className="step-title">{step.title}</div>
      <div className="step-detail">{step.detail}</div>
      <div className="row step-foot">
        <st.icon size={13} color={st.color} className={step.state.kind === 'running' ? 'spin' : ''} />
        <span style={{ color: st.color }}>{st.label}</span>
        <div className="spacer" />
        <button className="btn small icon" disabled={d.running} title="Run just this step"
          onClick={(e) => { e.stopPropagation(); void deploy.runOne(step.id) }}>
          <Play size={11} fill="currentColor" />
        </button>
      </div>
      {step.state.kind === 'running' && <div className="step-progress" />}
    </div>
  )
}

function Connector({ from, to }: { from: DeployStep; to: DeployStep }) {
  const live = from.state.kind === 'ok' && to.state.kind === 'running'
  const done = from.state.kind === 'ok' && (to.state.kind === 'ok' || to.state.kind === 'failed')
  return (
    <div className={`connector ${live ? 'live' : ''} ${done ? 'done' : ''}`}>
      <div className="connector-line" />
      <ChevronRight size={14} />
    </div>
  )
}

function Console({ filter, onClear }: { filter: string | null; onClear: () => void }) {
  const d = useDeploy()
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const lines = filter ? d.log.filter((l) => l.step === filter) : d.log
  const filterTitle = d.steps.find((s) => s.id === filter)?.title

  useEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines.length])

  return (
    <div className="console">
      <div className="row console-bar">
        <Terminal size={13} />
        <span>Output</span>
        {filterTitle && (
          <button className="chip console-chip" onClick={onClear} title="Show all steps">{filterTitle} ×</button>
        )}
        <div className="spacer" />
        <span className="faint">{lines.length} lines</span>
        <button className="btn small ghost" onClick={() => deploy.set({ log: [] })} disabled={d.running}>Clear</button>
      </div>
      <div
        className="console-body selectable"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {lines.length === 0 ? (
          <div className="console-empty">Run the pipeline, or click ▶ on a single step.</div>
        ) : (
          lines.map((l) => (
            <div key={l.id} className={`console-line ${l.header ?? ''}`}>{l.text || ' '}</div>
          ))
        )}
      </div>
    </div>
  )
}
