import { useSyncExternalStore } from 'react'
import { validateImage, validateLabel } from './resources'

export type WorkspaceMode = 'none' | 'existing' | 'new'
export type ConfigMode = 'none' | 'custom'
export type Template = 'blank' | 'simple' | 'gemini' | 'openai' | 'claude-managed-agents' | 'github-actions'

export interface KeyValue { id: number; key: string; value: string }
export interface RepoDraft { id: number; name: string; repo: string; branch: string }
export interface FileDraft { id: number; path: string; content: string }
export interface ServerDraft { id: number; name: string; endpoint: string }

export interface Draft {
  // Task
  name: string
  atespace: string
  image: string
  command: string
  env: KeyValue[]
  cpu: number
  memoryMi: number
  debug: boolean
  // Runner config
  configMode: ConfigMode
  customConfig: string
  // Workspace
  workspaceMode: WorkspaceMode
  existingWorkspace: string
  wsName: string
  repos: RepoDraft[]
  files: FileDraft[]
  servers: ServerDraft[]
  // Model
  includeModel: boolean
  modelName: string
  provider: string
  modelID: string
  secretName: string
  secretKey: string
  maxTokens: number
  // Raw editing
  rawMode: boolean
  rawYAML: string
  filePath: string | null
}

let nextID = 1
export const uid = () => nextID++

/** 32 random bits as 8 hex characters. */
export const hexID = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')

/** The name with a fresh `-<8 hex>` ID, replacing any ID it already ends with. */
export const withID = (name: string) => `${name.replace(/-[0-9a-f]{8}$/, '')}-${hexID()}`

export const TEMPLATES: { id: Template; title: string; group?: string }[] = [
  { id: 'blank', title: 'Blank' },
  { id: 'simple', title: 'Shell task' },
  { id: 'gemini', title: 'Gemini Agent', group: 'ax-images' },
  { id: 'openai', title: 'OpenAI Agent', group: 'ax-images' },
  { id: 'claude-managed-agents', title: 'Claude Agent', group: 'ax-images' },
  { id: 'github-actions', title: 'GitHub Actions Runner', group: 'ax-images' },
]

function blank(): Draft {
  return {
    name: 'my-task', atespace: '', image: '', command: '', env: [], cpu: 1, memoryMi: 512, debug: true,
    configMode: 'none', customConfig: 'key: value\n',
    workspaceMode: 'none', existingWorkspace: '', wsName: 'my-workspace', repos: [], files: [], servers: [],
    includeModel: false, modelName: 'default-model', provider: 'anthropic', modelID: 'claude-opus-5-5',
    secretName: 'anthropic-api-secret', secretKey: 'ANTHROPIC_API_KEY', maxTokens: 16000,
    rawMode: false, rawYAML: '', filePath: null,
  }
}

/** Images and digests from github.com/rakyll/ax-images v0.3.1. */
const AX_IMAGES = 'ghcr.io/rakyll/ax-images'
const IMAGE_DIGESTS = {
  gemini: 'sha256:e3d8d953fc1ca112e3b0d00a655d82008996a328a5e8dbd1777f68f492fb91bc',
  openai: 'sha256:9eeeb86183c1514ca4e3da8f412c2f704a457be13ba9797ebb1d942ba89417c1',
  'claude-managed-agents': 'sha256:af84c607dd0b2870046d0e5617ccebc4188f54f24ed2aab8d52e14e4554d83f3',
  'github-actions': 'sha256:1f5b1798b306e4214e77cf655afbc5a339c5b4b15c9ee4aebc04142d737e60eb',
}
const image = (name: keyof typeof IMAGE_DIGESTS) => `${AX_IMAGES}/${name}@${IMAGE_DIGESTS[name]}`

const AGENT_PROMPT = `prompt: |
  Read the repository, install it with its test dependencies, and run the
  test suite. Fix any failing or flaky tests you find. If everything passes,
  make one small, clearly correct improvement to the README. Finish by
  writing a short markdown report of what you checked and what you changed
  to /workspace/agent-output.md.
`

/** The ax-images coding agents work on a small Python library. */
function agentTask(d: Draft, name: keyof typeof IMAGE_DIGESTS, config: string, secrets: string[]): Draft {
  return {
    ...d,
    name,
    image: image(name),
    cpu: 2,
    memoryMi: 4096,
    configMode: 'custom',
    customConfig: config,
    env: secrets.map((key) => ({ id: uid(), key, value: '' })),
    workspaceMode: 'new',
    wsName: `itsdangerous-${name}`,
    repos: [{ id: uid(), name: 'origin', repo: 'https://github.com/pallets/itsdangerous.git', branch: 'main' }],
    files: [{
      id: uid(),
      path: 'AGENTS.md',
      content: `# Working in this repo
- Pure-Python library. Install with \`pip install -e . pytest\`, test with \`pytest\`.
- Keep changes small and focused; do not add runtime dependencies.
- Do not push or open pull requests. Leave changes in the working tree.
`,
    }],
  }
}

/**
 * The built-in templates leave spec.image empty so the server runs its
 * configured runner (AX_DEFAULT_TASK_IMAGE): a pinned gcr.io image would need
 * registry credentials that kind nodes and fresh machines don't have. The
 * ax-images templates use their public, digest-pinned ghcr.io images.
 */
/** A template's draft, its task name ending in a fresh hex ID. */
export function template(t: Template): Draft {
  const d = templateDraft(t)
  return { ...d, name: withID(d.name) }
}

function templateDraft(t: Template): Draft {
  const d = blank()
  switch (t) {
    case 'blank':
      return d
    case 'simple':
      return { ...d, name: 'shell-task', command: "sh -c 'echo $ENVIRONMENT'", env: [{ id: uid(), key: 'ENVIRONMENT', value: 'test' }] }
    case 'gemini':
      return agentTask(d, 'gemini', AGENT_PROMPT + `model: gemini-3.8-flash
maxTurns: 50
builtinTools: ["google_search", "url_context"]
`, ['GEMINI_API_KEY'])
    case 'openai':
      return agentTask(d, 'openai', AGENT_PROMPT + `model: gpt-5.5
maxTurns: 50
builtinTools: ["web_search"]
`, ['OPENAI_API_KEY'])
    case 'claude-managed-agents':
      // The agent's model, system prompt and tools live on the Claude Platform.
      return agentTask(d, 'claude-managed-agents', `environment: "env_..."
agent: "agent_..."
` + AGENT_PROMPT, ['ANTHROPIC_API_KEY', 'ANTHROPIC_ENVIRONMENT_KEY'])
    case 'github-actions':
      // Each job checks out its own code, so there's no workspace.
      return {
        ...d,
        name: 'github-actions',
        image: image('github-actions'),
        cpu: 2,
        memoryMi: 4096,
        debug: false,
        configMode: 'custom',
        customConfig: `repository: "<owner>/<repo>"
labels: ["self-hosted", "ax"]
jobs: 1
`,
        env: [{ id: uid(), key: 'GITHUB_TOKEN', value: '' }],
      }
  }
}

// MARK: Validation

export interface Issue { severity: 'error' | 'warning'; text: string }

export const isSecret = (key: string) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)

/** Why an env var name won't work, or null. */
export function validateEnvName(key: string, all: KeyValue[]): string | null {
  if (!key) return null
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return 'letters, digits and _, not starting with a digit'
  if (all.filter((kv) => kv.key === key).length > 1) return 'set more than once'
  return null
}

/** Parses .env-style text: NAME=value lines, with blank lines, comments and `export` ignored. */
export function parseEnv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    const key = (eq < 0 ? line : line.slice(0, eq)).trim()
    let value = eq < 0 ? '' : line.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1)
    out.push({ key, value })
  }
  return out
}

export const formatEnv = (env: KeyValue[]) => env.map((kv) => `${kv.key}=${kv.value}`).join('\n')

export function issues(d: Draft): Issue[] {
  if (d.rawMode) return []
  const out: Issue[] = []
  const err = (text: string) => out.push({ severity: 'error', text })
  const warn = (text: string) => out.push({ severity: 'warning', text })
  let e: string | null
  if ((e = validateLabel(d.name))) err(`Task name: ${e}`)
  if (d.atespace && (e = validateLabel(d.atespace))) err(`Atespace: ${e}`)
  if ((e = validateImage(d.image))) warn(`Image: ${e}`)
  if (d.image.includes('REPLACE_WITH')) err('Image: replace the placeholder digest')
  if (d.workspaceMode === 'new' && (e = validateLabel(d.wsName))) err(`Workspace name: ${e}`)
  if (d.workspaceMode === 'existing' && !d.existingWorkspace) err('Pick a workspace to bind')
  if (d.workspaceMode === 'new' && d.repos.some((r) => !r.repo)) warn('A git repo has no URL')
  if (d.includeModel && (e = validateLabel(d.modelName))) err(`Model name: ${e}`)
  if (d.env.some((kv) => !kv.key && kv.value)) warn('An env var has no name')
  if (d.env.some((kv) => validateEnvName(kv.key, d.env))) err('Environment: fix the highlighted names')
  if (d.env.some((kv) => isSecret(kv.key) && !kv.value)) warn('A credential env var is empty')
  return out
}

export const canApply = (d: Draft) => !issues(d).some((i) => i.severity === 'error')

// MARK: YAML

export const memoryString = (mi: number) => (mi >= 1024 && mi % 1024 === 0 ? `${mi / 1024}Gi` : `${Math.round(mi)}Mi`)
export const cpuString = (c: number) => (c < 1 ? `${Math.round(c * 1000)}m` : `${+c.toFixed(2)}`)

/** Double-quoted YAML scalar. */
export const q = (s: string) =>
  '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"'

/** Literal block scalar for multi-line text. */
function block(s: string, indent: number) {
  if (!s.includes('\n')) return q(s)
  const pad = ' '.repeat(indent)
  return '|\n' + s.trimEnd().split('\n').map((l) => (l ? pad + l : '')).join('\n')
}

/** Splits a command line the way a POSIX shell would for quoting purposes. */
export function tokenize(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let any = false
  let escape = false
  for (const ch of s) {
    if (escape) { cur += ch; escape = false; continue }
    if (ch === '\\' && quote !== "'") { escape = true; any = true; continue }
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; any = true; continue }
    if (/\s/.test(ch)) {
      if (any || cur) { out.push(cur); cur = ''; any = false }
      continue
    }
    cur += ch
  }
  if (any || cur) out.push(cur)
  return out
}

export function generate(d: Draft, redact = false): string {
  if (d.rawMode) return d.rawYAML
  const docs: string[] = []
  const ates = d.atespace ? `\n  atespace: ${q(d.atespace)}` : ''

  if (d.includeModel) {
    let y = `apiVersion: ax.io/v1alpha1\nkind: Model\nmetadata:\n  name: ${q(d.modelName)}${ates}\nspec:\n  provider: ${q(d.provider)}\n  model: ${q(d.modelID)}\n  secretKey:\n    name: ${q(d.secretName)}\n    key: ${q(d.secretKey)}`
    if (d.maxTokens > 0) y += `\n  parameters:\n    maxTokens: ${d.maxTokens}`
    docs.push(y)
  }

  if (d.workspaceMode === 'new') {
    let y = `apiVersion: ax.io/v1alpha1\nkind: Workspace\nmetadata:\n  name: ${q(d.wsName)}${ates}\nspec:`
    let empty = true
    if (d.repos.length) {
      empty = false
      y += '\n  git:'
      for (const r of d.repos) {
        y += `\n    - name: ${q(r.name || 'origin')}\n      repo: ${q(r.repo)}`
        if (r.branch) y += `\n      branch: ${q(r.branch)}`
      }
    }
    if (d.files.length) {
      empty = false
      y += '\n  files:'
      for (const f of d.files) y += `\n    - path: ${q(f.path)}\n      content: ${block(f.content, 8)}`
    }
    if (d.servers.length) {
      empty = false
      y += '\n  mcp:\n    servers:'
      for (const s of d.servers) y += `\n      - name: ${q(s.name)}\n        endpoint: ${q(s.endpoint)}`
    }
    if (empty) y += ' {}'
    docs.push(y)
  }

  let t = `apiVersion: ax.io/v1alpha1\nkind: Task\nmetadata:\n  name: ${q(d.name)}${ates}\nspec:`
  if (d.image) t += `\n  image: ${q(d.image)}`
  const argv = tokenize(d.command)
  if (argv.length) t += `\n  command: [${argv.map(q).join(', ')}]`
  if (d.configMode === 'custom') {
    t += '\n  config:\n' + d.customConfig.split('\n').map((l) => '    ' + l).join('\n').trimEnd()
  }
  const env = d.env.filter((kv) => kv.key)
  if (env.length) {
    t += '\n  env:'
    for (const kv of env) {
      const v = redact && isSecret(kv.key) && kv.value ? '••••••••' : kv.value
      t += `\n    - name: ${q(kv.key)}\n      value: ${q(v)}`
    }
  }
  t += `\n  resources:\n    limits:\n      cpu: ${q(cpuString(d.cpu))}\n      memory: ${q(memoryString(d.memoryMi))}`
  if (d.workspaceMode === 'existing' && d.existingWorkspace) t += `\n  workspace:\n    name: ${q(d.existingWorkspace)}`
  if (d.workspaceMode === 'new') t += `\n  workspace:\n    name: ${q(d.wsName)}`
  if (d.debug) t += '\n  debug: true'
  docs.push(t)

  return docs.join('\n---\n') + '\n'
}

// MARK: State

class DesignerStore {
  draft: Draft = template('simple')
  private listeners = new Set<() => void>()
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  set(patch: Partial<Draft>) {
    this.draft = { ...this.draft, ...patch }
    for (const l of this.listeners) l()
  }
  load(t: Template) {
    this.draft = template(t)
    for (const l of this.listeners) l()
  }
  enterRawMode() {
    this.set({ rawYAML: generate(this.draft), rawMode: true })
  }
  async open(repoPath: string) {
    const f = await window.studio.openYAML(`${repoPath}/examples`)
    if (f) this.set({ rawYAML: f.text, rawMode: true, filePath: f.path })
  }
  async save() {
    const name = this.draft.filePath?.split(/[\\/]/).pop() ?? `${this.draft.name}.yaml`
    const path = await window.studio.saveYAML(name, generate(this.draft))
    if (path) this.set({ filePath: path })
  }
}

export const designer = new DesignerStore()
export const useDraft = () => useSyncExternalStore(designer.subscribe, () => designer.draft)
