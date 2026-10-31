// The bridge between the renderer and the main process. The renderer never
// touches Node directly; everything that spawns processes or touches the
// filesystem goes through these calls.

export interface CommandResult {
  status: number
  stdout: string
  stderr: string
}

export interface RunRequest {
  program: string
  args: string[]
  stdin?: string
  cwd?: string
  env?: Record<string, string>
}

export interface StreamRequest {
  id: string
  /** Run by the platform shell (sh/zsh, or bash/cmd on Windows). */
  commandLine: string
  cwd?: string
  env?: Record<string, string>
}

export interface StreamLine {
  id: string
  line: string
}

export interface StreamExit {
  id: string
  status: number
}

export interface PlatformInfo {
  os: 'darwin' | 'win32' | 'linux' | string
  home: string
  pathSeparator: string
  version: string
}

export interface StudioAPI {
  platform(): Promise<PlatformInfo>
  run(req: RunRequest): Promise<CommandResult>
  stream(req: StreamRequest): Promise<void>
  cancelStream(id: string): Promise<void>
  onStreamLine(cb: (l: StreamLine) => void): () => void
  onStreamExit(cb: (e: StreamExit) => void): () => void
  which(program: string): Promise<string | null>
  /** Opens `program args...` in the platform's terminal. */
  openTerminal(title: string, program: string, args: string[]): Promise<string | null>
  /** Writes a kubeconfig that only sets current-context; returns a KUBECONFIG value. */
  kubeconfigFor(context: string): Promise<string>
  fileExists(path: string): Promise<boolean>
  openYAML(defaultDir?: string): Promise<{ path: string; text: string } | null>
  saveYAML(name: string, text: string): Promise<string | null>
  onMenu(cb: (action: string) => void): () => void
}

declare global {
  interface Window {
    studio: StudioAPI
  }
}
