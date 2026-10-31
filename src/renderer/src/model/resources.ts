import { parse as parseYAML } from 'yaml'

// MARK: Phase

/** A task's `status.phase`. Unknown phases are kept verbatim so a newer server never breaks the UI. */
export type Phase = 'pending' | 'running' | 'suspended' | 'completed' | 'failed' | 'terminating' | (string & {})

export const PHASES: Phase[] = ['pending', 'running', 'suspended', 'completed', 'failed', 'terminating']

export function toPhase(raw: string | undefined): Phase {
  const s = (raw ?? '').toLowerCase()
  if (s === '' || s === '<none>') return 'pending'
  if (s === 'succeeded') return 'completed'
  return s
}

export const phaseLabel = (p: Phase) => p.charAt(0).toUpperCase() + p.slice(1)

/**
 * Phase colors carry state, so they come from the reserved status palette and
 * always ship with an icon and label, never color alone.
 */
export const PHASE_COLOR: Record<string, string> = {
  pending: '#FAB219',
  running: '#0CA30C',
  suspended: '#2A78D6',
  completed: '#8A8984',
  failed: '#D03B3B',
  terminating: '#EC835A',
}
export const phaseColor = (p: Phase) => PHASE_COLOR[p] ?? '#8A8984'

const order = (p: Phase) => {
  const i = PHASES.indexOf(p)
  return i < 0 ? PHASES.length : i
}
export const comparePhase = (a: Phase, b: Phase) => order(a) - order(b)

// MARK: Resources

export interface AXTask {
  id: string
  name: string
  atespace: string
  phase: Phase
  actor?: string
  workerIP?: string
  age: string
}

export interface Condition {
  type: string
  status: string
  reason: string
  message: string
  updateTime?: string
}

/** What `ax get task <name>` adds on top of the list view. */
export interface TaskDetail {
  workspace?: string
  image?: string
  command: string[]
  env: { name: string; value: string }[]
  cpu?: string
  memory?: string
  debug: boolean
  createTime?: string
  conditions: Condition[]
  manifest: string
}

export interface GitRepo {
  name: string
  repo: string
  branch: string
}

export interface AXWorkspace {
  id: string
  name: string
  atespace: string
  gitCount: number
  mcpCount: number
  repos: GitRepo[]
  mcpServers: { name: string; endpoint: string }[]
  files: string[]
}

export interface AXModel {
  id: string
  name: string
  atespace: string
  provider: string
  model: string
}

export interface AXContext {
  name: string
  description: string
  isCurrent: boolean
}

export const isLocal = (c?: AXContext) => c?.name === 'local'

/** GKE context names are long; show the cluster part. */
export function shortName(name: string): string {
  const parts = name.split('_')
  return name.startsWith('gke_') && parts.length >= 4 ? parts.slice(3).join('_') : name
}

// MARK: Parsing `ax` output

const none = (s?: string) => (s && s !== '<none>' ? s : undefined)

/**
 * Parses a tabwriter table into rows keyed by header. Every column `ax`
 * prints in list views is a single token, so whitespace splitting is exact.
 */
export function parseTable(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((l) => l.trim())
  if (!lines.length) return []
  const keys = lines[0].trim().split(/\s+/)
  return lines.slice(1).map((line) => {
    const values = line.trim().split(/\s+/)
    return Object.fromEntries(keys.map((k, i) => [k, values[i] ?? '']))
  })
}

export const parseTasks = (text: string): AXTask[] =>
  parseTable(text)
    .filter((r) => r.NAME)
    .map((r) => {
      const atespace = r.ATESPACE || 'default'
      return {
        id: `${atespace}/${r.NAME}`,
        name: r.NAME,
        atespace,
        phase: toPhase(r.PHASE),
        actor: none(r.ACTOR),
        workerIP: none(r['WORKER-IP']),
        age: r.AGE ?? '',
      }
    })

export const parseWorkspaces = (text: string): AXWorkspace[] =>
  parseTable(text)
    .filter((r) => r.NAME)
    .map((r) => {
      const atespace = r.ATESPACE || 'default'
      return {
        id: `${atespace}/${r.NAME}`,
        name: r.NAME,
        atespace,
        gitCount: Number(r['GIT-REPOS']) || 0,
        mcpCount: Number(r['MCP-SERVERS']) || 0,
        repos: [],
        mcpServers: [],
        files: [],
      }
    })

export const parseModels = (text: string): AXModel[] =>
  parseTable(text)
    .filter((r) => r.NAME)
    .map((r) => {
      const atespace = r.ATESPACE || 'default'
      return { id: `${atespace}/${r.NAME}`, name: r.NAME, atespace, provider: r.PROVIDER ?? '', model: r.MODEL ?? '' }
    })

/** `ax config get-contexts`: an optional `*` marker, the name, then a free-text description. */
export function parseContexts(text: string): AXContext[] {
  return text
    .split('\n')
    .slice(1)
    .map((raw) => {
      const isCurrent = raw.trim().startsWith('*')
      const line = raw.replace('*', ' ').trim()
      if (!line) return null
      const name = line.split(/\s+/)[0]
      return { name, description: line.slice(name.length).trim(), isCurrent }
    })
    .filter((c): c is AXContext => c !== null)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseTaskYAML(text: string): TaskDetail {
  const doc: any = parseYAML(text) ?? {}
  const spec = doc.spec ?? {}
  const status = doc.status ?? {}
  return {
    workspace: spec.workspace?.name,
    image: spec.image,
    command: Array.isArray(spec.command) ? spec.command.map(String) : [],
    env: Array.isArray(spec.env) ? spec.env.map((e: any) => ({ name: String(e.name ?? ''), value: String(e.value ?? '') })) : [],
    cpu: spec.resources?.limits?.cpu,
    memory: spec.resources?.limits?.memory,
    debug: !!spec.debug,
    createTime: doc.metadata?.createTime,
    conditions: Array.isArray(status.conditions)
      ? status.conditions.map((c: any) => ({
          type: String(c.type ?? ''),
          status: String(c.status ?? ''),
          reason: String(c.reason ?? ''),
          message: String(c.message ?? ''),
          updateTime: c.updateTime,
        }))
      : [],
    manifest: text,
  }
}

export function parseWorkspaceYAML(text: string, ws: AXWorkspace): AXWorkspace {
  const spec: any = (parseYAML(text) ?? {}).spec ?? {}
  return {
    ...ws,
    repos: (spec.git ?? []).map((g: any) => ({ name: String(g.name ?? ''), repo: String(g.repo ?? ''), branch: String(g.branch ?? 'main') })),
    mcpServers: (spec.mcp?.servers ?? []).map((s: any) => ({ name: String(s.name ?? ''), endpoint: String(s.endpoint ?? '') })),
    files: (spec.files ?? []).map((f: any) => String(f.path ?? '')),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Last non-empty line of stderr (or stdout), without cobra's "Error: " prefix. */
export function errorSummary(stdout: string, stderr: string): string {
  const lines = (stderr || stdout).split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? 'command failed'
  return last.replace(/^Error:\s*/, '')
}

// MARK: Validation

/** `metadata.name` and `metadata.atespace` must be RFC 1123 labels. */
export function validateLabel(s: string): string | null {
  if (!s) return 'required'
  if (s.length > 63) return 'at most 63 characters'
  return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(s) ? null : "lowercase letters, digits and '-', starting and ending alphanumeric"
}

/** Substrate rejects images that aren't pinned by digest. */
export function validateImage(s: string): string | null {
  if (!s) return null
  return s.includes('@sha256:') ? null : 'pin by digest (image@sha256:…) or Substrate will reject it'
}

/** `registry/path/name@sha256:abcd…` → `name@abcd123`. */
export function shortImage(s?: string): string {
  if (!s) return ''
  const [ref, digest] = s.split('@')
  const name = ref.split('/').pop() ?? ref
  return digest ? `${name}@${digest.replace('sha256:', '').slice(0, 7)}` : name
}

/** `https://github.com/org/repo.git` → `repo`. */
export const repoName = (url: string) => url.replace(/\.git$/, '').split('/').pop() || url
