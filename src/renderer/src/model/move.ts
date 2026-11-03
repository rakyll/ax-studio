import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { errorSummary, toPhase, type AXTask, type Phase } from './resources'
import { store } from './store'

/**
 * Moving a task to another cluster or atespace. AX checkpoints only a task's
 * /workspace volume, and those snapshots are indexed by the source cluster, so
 * a move recreates the task at the destination and streams the workspace
 * across with tar over `ax ssh`. Running processes restart; files survive.
 */

export interface MoveTarget { context: string; atespace: string }

export type StepState = 'pending' | 'running' | 'done' | 'failed'
export interface MoveStep { title: string; state: StepState; detail?: string }

/** How long to wait for a task to reach a phase before giving up. */
const PHASE_TIMEOUT = 180_000

const scopeOf = (to: MoveTarget) => [...(to.context ? ['--context', to.context] : []), '-a', to.atespace || 'default']

async function ax(scope: string[], args: string[], stdin?: string) {
  const r = await window.studio.run({ program: store.state.settings.axPath, args: [...scope, ...args], stdin })
  return { ...r, ok: r.status === 0, error: errorSummary(r.stdout, r.stderr) }
}

async function must(scope: string[], args: string[], stdin?: string) {
  const r = await ax(scope, args, stdin)
  if (!r.ok) throw new Error(r.error)
  return r.stdout
}

/** A resource as fetched from one place, ready to apply in another. */
function portable(text: string, atespace: string): string {
  const doc = parseYAML(text) ?? {}
  delete doc.status
  if (doc.metadata) {
    delete doc.metadata.createTime
    doc.metadata.atespace = atespace || 'default'
  }
  return stringifyYAML(doc)
}

async function phaseOf(scope: string[], name: string): Promise<Phase> {
  return toPhase(parseYAML(await must(scope, ['get', 'task', name]))?.status?.phase)
}

async function waitFor(scope: string[], name: string, want: Phase) {
  const deadline = Date.now() + PHASE_TIMEOUT
  for (;;) {
    const p = await phaseOf(scope, name)
    if (p === want) return
    if (p === 'failed') throw new Error(`${name} failed`)
    if (Date.now() > deadline) throw new Error(`${name} is still ${p} after ${PHASE_TIMEOUT / 1000}s`)
    await new Promise((r) => setTimeout(r, 2000))
  }
}

async function ensureRunning(scope: string[], name: string) {
  const p = await phaseOf(scope, name)
  if (p === 'running') return
  if (p !== 'pending') await must(scope, ['resume', 'task', name])
  await waitFor(scope, name, 'running')
}

export function moveSteps(to: MoveTarget, deleteOriginal: boolean, path = '/workspace'): MoveStep[] {
  return [
    { title: 'Read the task and its workspace', state: 'pending' },
    { title: `Create it in ${to.context || 'the current context'} / ${to.atespace || 'default'}`, state: 'pending' },
    { title: 'Start both copies', state: 'pending' },
    { title: `Copy ${path}`, state: 'pending' },
    { title: 'Restart the new copy on the copied files', state: 'pending' },
    { title: deleteOriginal ? 'Delete the original' : 'Suspend the original', state: 'pending' },
  ]
}

/** Moves `t` from the current scope to `to`, reporting each step. Resolves to whether it finished. */
export async function moveTask(
  t: AXTask, to: MoveTarget, deleteOriginal: boolean, onProgress: (steps: MoveStep[]) => void,
): Promise<boolean> {
  const from = store.scope
  const dest = scopeOf(to)
  let steps = moveSteps(to, deleteOriginal)
  let current = 0
  const update = (i: number, state: StepState, detail?: string) => {
    steps = steps.map((s, j) => (j === i ? { ...s, state, detail: detail ?? s.detail } : s))
    onProgress(steps)
  }
  const step = async <T>(i: number, fn: () => Promise<T>) => {
    current = i
    update(i, 'running')
    const v = await fn()
    update(i, 'done')
    return v
  }
  let created = false
  try {
    const { manifests, path, reused } = await step(0, async () => {
      const task = parseYAML(await must(from, ['get', 'task', t.name]))
      if (!task?.spec?.debug) throw new Error('Moving copies files over ax ssh, which needs spec.debug: true on the task.')
      const docs = [portable(stringifyYAML(task), to.atespace)]
      const ws: string | undefined = task.spec.workspace?.name
      let reused = false
      if (ws) {
        if ((await ax(dest, ['get', 'workspace', ws])).ok) reused = true
        else docs.unshift(portable(await must(from, ['get', 'workspace', ws]), to.atespace))
      }
      return { manifests: docs.join('---\n'), path: String(task.spec.workspace?.path || '/workspace'), reused }
    })
    // Now that the workspace path is known, name it in the copy step.
    steps = moveSteps(to, deleteOriginal, path).map((s, i) => (i === 0 ? { ...s, state: 'done' } : s))
    onProgress(steps)

    await step(1, async () => {
      if ((await ax(dest, ['get', 'task', t.name])).ok) throw new Error(`A task named ${t.name} already exists there.`)
      await must(dest, ['apply', '-f', '-'], manifests)
      created = true
      if (reused) update(1, 'running', 'Uses the workspace already there')
    })

    await step(2, async () => {
      await ensureRunning(from, t.name)
      await ensureRunning(dest, t.name)
    })

    await step(3, async () => {
      const r = await window.studio.pipe({
        program: store.state.settings.axPath,
        from: [...from, 'ssh', t.name, '--', 'tar', 'cf', '-', '-C', path, '.'],
        to: [...dest, 'ssh', t.name, '--', 'tar', 'xf', '-', '-C', path],
      })
      if (r.status !== 0) throw new Error(errorSummary(r.stdout, r.stderr))
    })

    // The command started on an empty workspace; restart it so it sees the files.
    await step(4, async () => {
      await must(dest, ['suspend', 'task', t.name])
      await waitFor(dest, t.name, 'suspended')
      await must(dest, ['resume', 'task', t.name])
    })

    await step(5, async () => {
      if (deleteOriginal) await must(from, ['delete', 'task', t.name])
      else await must(from, ['suspend', 'task', t.name])
    })

    store.log(`Move ${t.name}`, `to ${to.context || 'current context'} / ${to.atespace || 'default'}`, true)
    await store.refresh(true)
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    update(current, 'failed', created ? `${msg} The new copy was left in place; delete it before retrying.` : msg)
    store.log(`Move ${t.name}`, msg, false)
    await store.refresh(true)
    return false
  }
}
