import type { State } from './store'
import type { AXTask, AXWorkspace } from './resources'

export interface WorkspaceGroup {
  id: string
  /** null for tasks that start in an empty /workspace. */
  ws: AXWorkspace | null
  tasks: AXTask[]
}

/** Tasks grouped by the workspace they mount, in workspace order, with unbound tasks last. */
export function workspaceGroups(s: Pick<State, 'tasks' | 'workspaces' | 'details'>): WorkspaceGroup[] {
  const groups: WorkspaceGroup[] = s.workspaces.map((ws) => ({
    id: `ws:${ws.name}`,
    ws,
    tasks: s.tasks.filter((t) => s.details[t.id]?.workspace === ws.name),
  }))
  const unbound = s.tasks.filter((t) => {
    const w = s.details[t.id]?.workspace
    return !w || !s.workspaces.some((ws) => ws.name === w)
  })
  if (unbound.length) groups.push({ id: 'ws:-', ws: null, tasks: unbound })
  return groups
}

/** A CPU limit in cores: "250m" is 0.25. */
export function cores(cpu?: string): number | undefined {
  if (!cpu) return undefined
  const n = cpu.endsWith('m') ? parseFloat(cpu) / 1000 : parseFloat(cpu)
  return isNaN(n) ? undefined : n
}
