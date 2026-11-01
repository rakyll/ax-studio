import { useSyncExternalStore } from 'react'
import { validateImage, validateLabel } from './resources'

export type WorkspaceMode = 'none' | 'existing' | 'new'
export type ConfigMode = 'none' | 'custom'
export type Template = 'blank' | 'simple' | 'team'

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

export const TEMPLATES: { id: Template; title: string; detail: string }[] = [
  { id: 'blank', title: 'Blank', detail: 'An empty task on the default runner image' },
  { id: 'simple', title: 'SSH task', detail: 'A task with Debug on, ready for ax ssh' },
  { id: 'team', title: 'Team workspace', detail: 'Two repos and MCP servers feeding one task' },
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

/**
 * Templates leave spec.image empty so the server runs its configured runner
 * (AX_DEFAULT_TASK_IMAGE): a pinned gcr.io image would need registry
 * credentials that kind nodes and fresh machines don't have.
 */
export function template(t: Template): Draft {
  const d = blank()
  switch (t) {
    case 'blank':
      return d
    case 'simple':
      return { ...d, name: 'ssh-task', command: "sh -c 'echo $ENVIRONMENT'", env: [{ id: uid(), key: 'ENVIRONMENT', value: 'test' }] }
    case 'team':
      return {
        ...d,
        name: 'fe-feature',
        command: 'sleep infinity',
        cpu: 1,
        memoryMi: 1024,
        env: [{ id: uid(), key: 'GOAL', value: 'ship the new settings page' }],
        workspaceMode: 'new',
        wsName: 'web-team',
        repos: [
          { id: uid(), name: 'app', repo: 'https://github.com/vitejs/vite-plugin-react.git', branch: 'main' },
          { id: uid(), name: 'design-system', repo: 'https://github.com/primer/css.git', branch: 'main' },
        ],
        servers: [
          { id: uid(), name: 'github', endpoint: 'https://api.githubcopilot.com/mcp/' },
          { id: uid(), name: 'linear', endpoint: 'https://mcp.linear.app/sse' },
        ],
        includeModel: true,
        modelName: 'claude-opus',
      }
  }
}

// MARK: Validation

export interface Issue { severity: 'error' | 'warning'; text: string }

export const isSecret = (key: string) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)

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
  if (d.env.some((kv) => !kv.key)) warn('An env var has no name')
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
