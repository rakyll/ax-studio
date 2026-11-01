import { useSyncExternalStore } from 'react'
import type { ContainerRuntime } from '../../../shared/api'
import type { ConsoleLine } from '../components'
import { store } from './store'

/** Ready/total replicas, or null when the component isn't installed. */
export type Replicas = { ready: number; total: number } | null

export interface Cluster {
  name: string
  context: string
  reachable: boolean
  nodes: Replicas
  version: string
  substrate: Replicas
  substrateCommit: string
  ax: Replicas
  workers: Replicas
  /** Whether kind-<name> is in your kubeconfig, which ax needs to reach it. */
  inKubeconfig: boolean
}

export type StageID = 'kind' | 'substrate' | 'workers' | 'ax'
export const STAGES: { id: StageID; title: string }[] = [
  { id: 'kind', title: 'Kind cluster' },
  { id: 'substrate', title: 'Agent Substrate' },
  { id: 'workers', title: 'Worker pool' },
  { id: 'ax', title: 'AX control plane' },
]

export interface Operation {
  kind: 'create' | 'install' | 'delete' | 'kubeconfig'
  cluster: string
  stage: StageID | null
  status: 'running' | 'ok' | 'failed'
  exit?: number
  started: number
  finished?: number
}

export interface NewCluster {
  name: string
  workers: number
  substrateRef: string
}

export interface ClustersState {
  clusters: Cluster[]
  loading: boolean
  loaded: boolean
  runtime: ContainerRuntime | null
  /** Memory of the podman machine in MiB, on macOS and Windows. */
  machineMemory: number | null
  tools: Record<'kind' | 'kubectl' | 'go' | 'bash', boolean>
  scriptFound: boolean
  op: Operation | null
  log: ConsoleLine[]
  form: NewCluster
}

const SCRIPT = 'hack/setup-e2e-kind.sh'
/** Below this (MiB) the podman machine OOM-kills rustc while building Substrate's envoy image. */
const MIN_MACHINE_MEMORY = 6144
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

/** Prints key=value lines describing kind cluster $1; kubectl reads a throwaway kubeconfig from kind. */
const PROBE = `
kc=$(mktemp)
if ! kind get kubeconfig --name "$1" > "$kc" 2>/dev/null; then echo reachable=0; rm -f "$kc"; exit 0; fi
k() { kubectl --kubeconfig "$kc" --request-timeout=5s "$@" 2>/dev/null; }
if ! n=$(k get nodes --no-headers); then echo reachable=0; rm -f "$kc"; exit 0; fi
echo reachable=1
echo "nodes=$(printf '%s\\n' "$n" | awk '$2 ~ /^Ready/ { r++ } END { print r+0 "/" NR }')"
echo "version=$(k get nodes -o jsonpath='{.items[0].status.nodeInfo.kubeletVersion}')"
echo "substrate=$(k -n ate-system get deploy ate-api-server -o jsonpath='{.status.readyReplicas}/{.spec.replicas}')"
echo "commit=$(k get ns ate-system -o jsonpath='{.metadata.annotations.substrate-commit}')"
echo "ax=$(k -n ax-system get deploy ax-server -o jsonpath='{.status.readyReplicas}/{.spec.replicas}')"
echo "workers=$(k -n ax-system get workerpool ax-workers -o jsonpath='{.status.readyReplicas}/{.spec.replicas}')"
rm -f "$kc"
`

function replicas(v: string | undefined): Replicas {
  if (!v || !v.includes('/')) return null
  const [r, t] = v.split('/')
  if (t === '') return null
  return { ready: Number(r) || 0, total: Number(t) || 0 }
}

/** Which of the setup script's "==> " progress lines starts which stage. */
function stageFor(line: string): StageID | null {
  if (!line.startsWith('==> ')) return null
  if (/Kind cluster/.test(line)) return 'kind'
  if (/Installing Substrate|Substrate .* already installed/.test(line)) return 'substrate'
  if (/WorkerPool|ax-workers/.test(line)) return 'workers'
  if (/Building ax|Deploying ax-postgres/.test(line)) return 'ax'
  return null
}

class ClustersStore {
  state: ClustersState = {
    clusters: [],
    loading: false,
    loaded: false,
    runtime: null,
    machineMemory: null,
    tools: { kind: true, kubectl: true, go: true, bash: true },
    scriptFound: true,
    op: null,
    log: [],
    form: { name: '', workers: 2, substrateRef: '' },
  }
  private listeners = new Set<() => void>()
  private lineID = 1
  private streamID = 0
  private pending: ConsoleLine[] = []
  private flushScheduled = false

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  set(patch: Partial<ClustersState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  setForm(patch: Partial<NewCluster>) {
    this.set({ form: { ...this.state.form, ...patch } })
  }

  get running() {
    return this.state.op?.status === 'running'
  }

  private async repoDir(): Promise<string> {
    return store.state.settings.repoPath.replace(/^~/, (await window.studio.platform()).home)
  }

  private env(): Record<string, string> {
    return this.state.runtime?.env ?? {}
  }

  async init() {
    const [runtime, kind, kubectl, go, bash, scriptFound] = await Promise.all([
      window.studio.containerRuntime(),
      window.studio.which('kind'),
      window.studio.which('kubectl'),
      window.studio.which('go'),
      window.studio.which('bash'),
      window.studio.fileExists(`${store.state.settings.repoPath}/${SCRIPT}`),
    ])
    this.set({ runtime, tools: { kind: !!kind, kubectl: !!kubectl, go: !!go, bash: !!bash }, scriptFound })
    if (runtime.runtime === 'podman') {
      const r = await window.studio.run({ program: 'podman', args: ['machine', 'inspect', '--format', '{{.Resources.Memory}}'] })
      const mib = parseInt(r.stdout, 10)
      this.set({ machineMemory: r.status === 0 && mib > 0 ? mib : null })
    }
    await this.refresh()
  }

  async refresh() {
    if (!this.state.tools.kind || !this.state.runtime?.runtime) {
      this.set({ clusters: [], loaded: true })
      return
    }
    this.set({ loading: true })
    try {
      const env = this.env()
      const [list, ctxs] = await Promise.all([
        window.studio.run({ program: 'kind', args: ['get', 'clusters'], env }),
        window.studio.run({ program: 'kubectl', args: ['config', 'get-contexts', '-o', 'name'] }),
      ])
      const names = list.status === 0 ? list.stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes(' ')) : []
      const contexts = new Set(ctxs.stdout.split('\n').map((l) => l.trim()))
      const clusters = await Promise.all(names.map(async (name): Promise<Cluster> => {
        const r = await window.studio.run({ program: '/bin/sh', args: ['-c', PROBE, 'probe', name], env })
        const kv = Object.fromEntries(r.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
        return {
          name,
          context: `kind-${name}`,
          reachable: kv.reachable === '1',
          nodes: replicas(kv.nodes),
          version: kv.version ?? '',
          substrate: replicas(kv.substrate),
          substrateCommit: kv.commit ?? '',
          ax: replicas(kv.ax),
          workers: replicas(kv.workers),
          inKubeconfig: contexts.has(`kind-${name}`),
        }
      }))
      const form = this.state.form.name ? this.state.form : { ...this.state.form, name: freeName(names) }
      this.set({ clusters, form })
    } finally {
      this.set({ loading: false, loaded: true })
    }
  }

  get problems(): string[] {
    const p: string[] = []
    const { tools, runtime } = this.state
    if (!tools.kind) p.push('kind is not installed (https://kind.sigs.k8s.io).')
    if (runtime && !runtime.runtime) p.push('Neither docker nor podman is installed.')
    if (!tools.kubectl) p.push('kubectl is not installed.')
    return p
  }

  /** Problems that only block creating or installing (they build AX and Substrate from source). */
  get buildProblems(): string[] {
    const p: string[] = []
    if (!this.state.scriptFound) p.push(`${SCRIPT} not found in ${store.state.settings.repoPath} (set the AX repo in Settings).`)
    if (!this.state.tools.go) p.push('Go is not installed; Substrate and AX are built from source.')
    if (!this.state.tools.bash) p.push('bash is required to run the setup script.')
    return p
  }

  /** Likely failures that don't block creating a cluster. */
  get warnings(): string[] {
    const mib = this.state.machineMemory
    if (mib === null || mib >= MIN_MACHINE_MEMORY) return []
    return [`The podman machine has ${Math.round(mib / 1024)} GiB of memory; building Agent Substrate needs about ${MIN_MACHINE_MEMORY / 1024} GiB and is killed with less. Run: podman machine stop && podman machine set --memory 8192 && podman machine start`]
  }

  nameProblem(name: string): string | null {
    if (!name) return 'Name the cluster.'
    if (!NAME_RE.test(name)) return 'Use lowercase letters, digits and dashes.'
    if (this.state.clusters.some((c) => c.name === name)) return `A kind cluster named ${name} already exists.`
    return null
  }

  /**
   * Runs AX's own setup script for the cluster. It creates the kind cluster if
   * needed, installs Substrate at the version AX is built against, builds and
   * deploys AX, then merges kind-<name> into your kubeconfig without changing
   * its current context. AX_SNAPSHOTS_BUCKET is cleared so a value exported
   * for a real cluster in the user's shell doesn't replace the script's kind
   * default.
   */
  private setupCommand(name: string, workers: number, substrateRef: string): string {
    const tmp = `.tmp/kubeconfig-${name}`
    return [
      'set -e',
      'ORIG=${KUBECONFIG:-$HOME/.kube/config}; ORIG=${ORIG%%:*}',
      `KUBECONFIG="$PWD/${tmp}" KIND_CLUSTER_NAME=${shq(name)} AX_WORKER_REPLICAS=${workers} AX_SNAPSHOTS_BUCKET=` +
        `${substrateRef ? ` SUBSTRATE_REF=${shq(substrateRef)}` : ''} bash ${SCRIPT}`,
      `printf '\\n==> Adding context kind-%s to %s\\n' ${shq(name)} "$ORIG"`,
      mergeScript(tmp),
    ].join('\n')
  }

  async create() {
    const { name, workers, substrateRef } = this.state.form
    await this.exec({ kind: 'create', cluster: name }, `Create ${name}`, this.setupCommand(name, workers, substrateRef.trim()))
  }

  async install(name: string) {
    await this.exec({ kind: 'install', cluster: name }, `Install AX on ${name}`, this.setupCommand(name, this.state.form.workers, this.state.form.substrateRef.trim()))
  }

  async remove(name: string) {
    await this.exec({ kind: 'delete', cluster: name }, `Delete ${name}`,
      `kind delete cluster --name ${shq(name)} && rm -f .tmp/kubeconfig-${name}`)
  }

  /** Adds kind-<name> to your kubeconfig (keeping its current context) so ax can use it. */
  async addToKubeconfig(name: string): Promise<boolean> {
    const tmp = `$TMPDIR/ax-studio-kind-${name}.yaml`
    const ok = await this.exec({ kind: 'kubeconfig', cluster: name }, `Add kind-${name} to kubeconfig`, [
      'set -e',
      'ORIG=${KUBECONFIG:-$HOME/.kube/config}; ORIG=${ORIG%%:*}',
      `TMPDIR=\${TMPDIR:-/tmp}; kind get kubeconfig --name ${shq(name)} > "${tmp}"`,
      mergeScript(tmp),
      `rm -f "${tmp}"`,
      `echo "kind-${name} added to $ORIG"`,
    ].join('\n'))
    return ok
  }

  async open(c: Cluster) {
    if (!c.inKubeconfig && !(await this.addToKubeconfig(c.name))) return
    await store.loadContexts()
    store.setScope({ context: c.context })
    store.setSection('overview')
  }

  cancel() {
    void window.studio.cancelStream(`clusters-${this.streamID}`)
  }

  private append(text: string, header?: ConsoleLine['header']) {
    this.pending.push({ id: this.lineID++, text, header })
    if (this.flushScheduled) return
    this.flushScheduled = true
    requestAnimationFrame(() => {
      this.flushScheduled = false
      const log = [...this.state.log, ...this.pending].slice(-5000)
      this.pending = []
      this.set({ log })
    })
  }

  private patchOp(patch: Partial<Operation>) {
    if (this.state.op) this.set({ op: { ...this.state.op, ...patch } })
  }

  private async exec(op: Pick<Operation, 'kind' | 'cluster'>, title: string, command: string): Promise<boolean> {
    if (this.running) return false
    const staged = op.kind === 'create' || op.kind === 'install'
    this.set({ op: { ...op, stage: staged ? 'kind' : null, status: 'running', started: Date.now() }, log: [] })
    this.append(`▶ ${title}`, 'start')
    const streamID = `clusters-${++this.streamID}`
    const cwd = await this.repoDir()
    const status = await new Promise<number>((resolve) => {
      const offLine = window.studio.onStreamLine((l) => {
        if (l.id !== streamID) return
        this.append(l.line)
        const stage = staged ? stageFor(l.line) : null
        if (stage) this.patchOp({ stage })
      })
      const offExit = window.studio.onStreamExit((e) => {
        if (e.id !== streamID) return
        offLine()
        offExit()
        resolve(e.status)
      })
      void window.studio.stream({ id: streamID, commandLine: command, cwd, env: this.env() })
    })
    const ok = status === 0
    this.patchOp({ status: ok ? 'ok' : 'failed', exit: status, finished: Date.now() })
    this.append(ok ? `✓ ${title} done` : `✗ ${title} failed (exit ${status})`, ok ? 'ok' : 'fail')
    if (ok && op.kind === 'create') this.setForm({ name: '' })
    void this.refresh()
    return ok
  }
}

/**
 * Merges the kubeconfig at $1 into $ORIG. kubectl keeps the first file's
 * current-context, so yours is unchanged; the old file is kept as a backup.
 */
function mergeScript(src: string): string {
  return [
    'mkdir -p "$(dirname "$ORIG")"',
    '[ -f "$ORIG" ] && cp "$ORIG" "$ORIG.ax-studio.bak"',
    `KUBECONFIG="$ORIG:${src}" kubectl config view --flatten > "$ORIG.ax-studio.tmp"`,
    'mv "$ORIG.ax-studio.tmp" "$ORIG"',
  ].join('\n')
}

function freeName(taken: string[]): string {
  if (!taken.includes('ax-dev')) return 'ax-dev'
  for (let i = 2; ; i++) if (!taken.includes(`ax-dev-${i}`)) return `ax-dev-${i}`
}

export const clusters = new ClustersStore()
export const useClusters = () => useSyncExternalStore(clusters.subscribe, () => clusters.state)
