import { useSyncExternalStore } from 'react'
import { store } from './store'

export type Arch = 'amd64' | 'arm64'
export type StepState = { kind: 'idle' } | { kind: 'running' } | { kind: 'ok' } | { kind: 'failed'; status: number } | { kind: 'skipped' }

export interface DeployStep {
  id: string
  title: string
  icon: string
  detail: string
  command: string
  enabled: boolean
  state: StepState
  duration?: number
}

export interface LogLine {
  id: number
  step: string
  text: string
  header?: 'start' | 'ok' | 'fail'
}

export interface DeployState {
  kubeContext: string
  kubeContexts: string[]
  imageRepo: string
  arches: Arch[]
  steps: DeployStep[]
  log: LogLine[]
  running: boolean
  currentStep: string | null
  repoFound: boolean
}

const REPO_KEY = 'ax-studio.deploy.imageRepo'
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

class DeployStore {
  state: DeployState = {
    kubeContext: '',
    kubeContexts: [],
    imageRepo: localStorage.getItem(REPO_KEY) ?? '',
    arches: ['amd64', 'arm64'],
    steps: [],
    log: [],
    running: false,
    currentStep: null,
    repoFound: true,
  }
  private listeners = new Set<() => void>()
  private lineID = 1
  private streamID = 0
  private initialized = false
  private pending: LogLine[] = []
  private flushScheduled = false

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  set(patch: Partial<DeployState>, rebuild = false) {
    this.state = { ...this.state, ...patch }
    if (patch.imageRepo !== undefined) localStorage.setItem(REPO_KEY, patch.imageRepo)
    if (rebuild) this.state = { ...this.state, steps: this.build() }
    for (const l of this.listeners) l()
  }

  async init() {
    if (this.initialized) {
      void this.checkRepo()
      return
    }
    this.initialized = true
    const r = await window.studio.run({ program: 'kubectl', args: ['config', 'get-contexts', '-o', 'name'] })
    const kubeContexts = r.status === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
    const axCtx = store.state.context
    const kubeContext = kubeContexts.find((c) => c === axCtx) ?? kubeContexts.find((c) => c.startsWith('kind-')) ?? kubeContexts[0] ?? ''
    this.set({ kubeContexts, kubeContext }, true)
    void this.checkRepo()
  }

  private async checkRepo() {
    this.set({ repoFound: await window.studio.fileExists(`${store.state.settings.repoPath}/Makefile`) })
  }

  /** Rebuilds the step list for the current settings, keeping each step's on/off switch. */
  private build(): DeployStep[] {
    const enabled = new Map(this.state.steps.map((s) => [s.id, s.enabled]))
    const ctx = this.state.kubeContext
    const repo = this.state.imageRepo.trim()
    const arches = this.state.arches
    const step = (id: string, title: string, icon: string, detail: string, command: string, on = true): DeployStep => ({
      id, title, icon, detail, command, enabled: enabled.get(id) ?? on, state: { kind: 'idle' },
    })
    return [
      step('substrate', 'Agent Substrate', 'layers', `Checks that ${ctx || 'the cluster'} is reachable and runs Substrate's Control API in ate-system.`,
        'kubectl get nodes --request-timeout=10s && kubectl get svc api -n ate-system --request-timeout=10s'),
      step('images', 'Build & push images', 'package',
        `Builds ax-server and ax-task-runner for ${arches.map((a) => `linux/${a}`).join(' + ')} and pushes ${arches.length > 1 ? 'multi-arch manifests' : 'them'} to ${repo || 'AX_IMAGE_REPO'}.`,
        imagesScript(repo, arches)),
      step('ax', 'AX', 'server', 'Deploys Postgres and ax-server to ax-system, pinned to the digests just pushed when available.',
        `make deploy-postgres && D=$(cat bin/ax-server.digest 2>/dev/null); T=$(cat bin/ax-task-runner.digest 2>/dev/null); ` +
          `make deploy-server AX_IMAGE_REPO=${shq(repo)} \${D:+AX_SERVER_IMAGE=${shq(repo)}/ax-server@$D} \${T:+AX_DEFAULT_TASK_IMAGE=${shq(repo)}/ax-task-runner@$T} && ` +
          'kubectl -n ax-system rollout status deployment/ax-server --timeout=180s'),
      step('verify', 'Verify', 'shield', 'Tunnels to the new control plane and lists tasks.', `ax --context ${shq(ctx)} get tasks`),
    ]
  }

  get problems(): string[] {
    const p: string[] = []
    if (!this.state.repoFound) p.push(`AX repo not found at ${store.state.settings.repoPath} (set it in Settings).`)
    if (!this.state.kubeContext) p.push('Choose a Kubernetes context.')
    if (this.state.arches.length === 0) p.push('Choose at least one image architecture.')
    const needsRepo = this.state.steps.some((s) => (s.id === 'images' || s.id === 'ax') && s.enabled)
    if (needsRepo && !this.state.imageRepo.trim()) p.push('Set the image registry (AX_IMAGE_REPO).')
    return p
  }

  toggle(id: string, enabled: boolean) {
    this.set({ steps: this.state.steps.map((s) => (s.id === id ? { ...s, enabled } : s)) })
  }

  private patchStep(id: string, patch: Partial<DeployStep>) {
    this.set({ steps: this.state.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  }

  /** Batches log lines into one render per frame; `make images` can print thousands. */
  private append(line: Omit<LogLine, 'id'>) {
    this.pending.push({ ...line, id: this.lineID++ })
    if (this.flushScheduled) return
    this.flushScheduled = true
    requestAnimationFrame(() => {
      this.flushScheduled = false
      const log = [...this.state.log, ...this.pending].slice(-5000)
      this.pending = []
      this.set({ log })
    })
  }

  async runAll() {
    this.set({
      running: true,
      log: [],
      steps: this.state.steps.map((s) => ({ ...s, state: s.enabled ? { kind: 'idle' } : { kind: 'skipped' }, duration: undefined })),
    })
    try {
      for (const s of this.state.steps) {
        if (!s.enabled) continue
        if (!(await this.run(s.id))) break
      }
    } finally {
      this.set({ running: false, currentStep: null })
    }
  }

  async runOne(id: string) {
    this.set({ running: true })
    try {
      await this.run(id)
    } finally {
      this.set({ running: false, currentStep: null })
    }
  }

  cancel() {
    void window.studio.cancelStream(`deploy-${this.streamID}`)
  }

  private async env(): Promise<Record<string, string>> {
    if (!this.state.kubeContext) return {}
    return { KUBECONFIG: await window.studio.kubeconfigFor(this.state.kubeContext) }
  }

  private async run(id: string): Promise<boolean> {
    const step = this.state.steps.find((s) => s.id === id)
    if (!step) return false
    this.patchStep(id, { state: { kind: 'running' }, duration: undefined })
    this.set({ currentStep: id })
    this.append({ step: id, text: `▶ ${step.title}   $ ${step.command}`, header: 'start' })
    const start = Date.now()
    const streamID = `deploy-${++this.streamID}`
    const cwd = store.state.settings.repoPath.replace(/^~/, (await window.studio.platform()).home)
    const env = await this.env()

    const status = await new Promise<number>((resolve) => {
      const offLine = window.studio.onStreamLine((l) => l.id === streamID && this.append({ step: id, text: l.line }))
      const offExit = window.studio.onStreamExit((e) => {
        if (e.id !== streamID) return
        offLine()
        offExit()
        resolve(e.status)
      })
      void window.studio.stream({ id: streamID, commandLine: step.command, cwd, env })
    })

    const ok = status === 0
    this.patchStep(id, { state: ok ? { kind: 'ok' } : { kind: 'failed', status }, duration: (Date.now() - start) / 1000 })
    this.append({ step: id, text: ok ? `✓ ${step.title} done` : `✗ ${step.title} failed (exit ${status})`, header: ok ? 'ok' : 'fail' })
    return ok
  }
}

/**
 * Cross-compiles both binaries per arch, then builds one image per arch into a
 * manifest list and pushes it, recording the list's digest the way `make images`
 * does so the AX step can pin to it. The repo Makefile only builds one arch.
 */
function imagesScript(repo: string, arches: Arch[]): string {
  const platforms = arches.map((a) => `linux/${a}`).join(',')
  return [
    'set -eu',
    `REPO=${shq(repo)}; TAG=latest; ARCHES=${shq(arches.join(' '))}`,
    'CLI=${CONTAINER_CLI:-$(command -v podman || command -v docker || true)}',
    '[ -n "$CLI" ] || { echo "error: neither podman nor docker found in PATH"; exit 1; }',
    'mkdir -p bin',
    'for a in $ARCHES; do',
    '  echo "==> Cross-compiling for linux/$a"; mkdir -p bin/linux_$a',
    '  for b in ax-server ax-task-runner; do GOOS=linux GOARCH=$a CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/linux_$a/$b ./cmd/$b; done',
    'done',
    'for b in ax-server ax-task-runner; do',
    '  img=$REPO/$b:$TAG; df=Dockerfile.${b#ax-}',
    '  if "$CLI" --version 2>/dev/null | grep -qi podman; then',
    '    "$CLI" manifest rm "$img" >/dev/null 2>&1 || "$CLI" rmi "$img" >/dev/null 2>&1 || true',
    '    for a in $ARCHES; do echo "==> Building $img for linux/$a"; "$CLI" build --platform linux/$a --build-arg TARGETARCH=$a --manifest "$img" -f "$df" .; done',
    '    echo "==> Pushing $img"; "$CLI" manifest push --all --digestfile bin/$b.digest "$img" "docker://$img"',
    '  else',
    `    echo "==> Building and pushing $img (${platforms})"`,
    `    "$CLI" buildx build --platform ${platforms} -f "$df" -t "$img" --push --metadata-file bin/$b.meta.json .`,
    `    sed -n 's/.*"containerimage.digest": *"\\([^"]*\\)".*/\\1/p' bin/$b.meta.json > bin/$b.digest`,
    '  fi',
    '  echo "    $img@$(cat bin/$b.digest)"',
    'done',
  ].join('\n')
}

export const deploy = new DeployStore()
export const useDeploy = () => useSyncExternalStore(deploy.subscribe, () => deploy.state)
