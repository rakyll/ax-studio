import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { CommandResult, RunRequest, StreamRequest } from '../shared/api'

const isWin = process.platform === 'win32'

/**
 * Apps launched from Finder, the Dock, or a desktop launcher don't inherit
 * the user's shell PATH, so ax, kubectl, podman and go would be missing.
 * Ask a login shell once and merge in the usual tool directories.
 */
function loginPath(): string {
  const base = process.env.PATH ?? ''
  if (isWin) return base
  try {
    const sh = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(sh, ['-ilc', 'printf "__AXPATH__%s" "$PATH"'], { timeout: 4000, encoding: 'utf8' })
    const i = out.lastIndexOf('__AXPATH__')
    if (i >= 0) return out.slice(i + 10).trim() + delimiter + base
  } catch {
    // Fall back to the inherited PATH plus well-known locations.
  }
  return base
}

const home = homedir()
const extra = isWin
  ? [join(home, 'go', 'bin'), join(home, 'scoop', 'shims')]
  : [join(home, 'go', 'bin'), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/local/go/bin',
     join(home, 'google-cloud-sdk', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin']

const PATH = [...new Set([...loginPath().split(delimiter), ...extra].filter(Boolean))].join(delimiter)

export const env: NodeJS.ProcessEnv = { ...process.env, PATH }

export function which(program: string): string | null {
  if (program.includes('/') || program.includes('\\')) return existsSync(program) ? program : null
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').concat(['']) : ['']
  for (const dir of PATH.split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, program + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}

export function run(req: RunRequest): Promise<CommandResult> {
  return new Promise((resolve) => {
    const program = which(req.program) ?? req.program
    let child: ChildProcess
    try {
      child = spawn(program, req.args, { cwd: req.cwd, env: { ...env, ...req.env }, windowsHide: true })
    } catch (e) {
      resolve({ status: 127, stdout: '', stderr: String(e) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (d) => (stdout += d))
    child.stderr?.setEncoding('utf8').on('data', (d) => (stderr += d))
    child.on('error', (e) => resolve({ status: 127, stdout, stderr: stderr + `${req.program}: ${e.message}` }))
    child.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
    if (req.stdin !== undefined) child.stdin?.end(req.stdin)
    else child.stdin?.end()
  })
}

/** The shell used for deploy steps. Steps are POSIX sh; on Windows prefer Git Bash. */
function shellFor(commandLine: string): [string, string[]] {
  if (!isWin) return ['/bin/sh', ['-c', commandLine]]
  const bash = which('bash')
  return bash ? [bash, ['-lc', commandLine]] : ['cmd.exe', ['/d', '/s', '/c', commandLine]]
}

const streams = new Map<string, ChildProcess>()

export function stream(req: StreamRequest, onLine: (line: string) => void, onExit: (status: number) => void) {
  const [sh, args] = shellFor(req.commandLine)
  const child = spawn(sh, args, { cwd: req.cwd, env: { ...env, ...req.env }, windowsHide: true })
  streams.set(req.id, child)
  // stdout and stderr share one buffer each so partial lines are never split.
  const buffers = { out: '', err: '' }
  const feed = (key: 'out' | 'err') => (chunk: string) => {
    buffers[key] += chunk
    const parts = buffers[key].split(/\r?\n/)
    buffers[key] = parts.pop() ?? ''
    for (const p of parts) onLine(p)
  }
  child.stdout?.setEncoding('utf8').on('data', feed('out'))
  child.stderr?.setEncoding('utf8').on('data', feed('err'))
  child.on('error', (e) => onLine(`error: ${e.message}`))
  child.on('close', (code, signal) => {
    for (const k of ['out', 'err'] as const) if (buffers[k]) onLine(buffers[k])
    streams.delete(req.id)
    onExit(code ?? (signal ? 130 : 1))
  })
}

export function cancel(id: string) {
  const child = streams.get(id)
  if (child && !child.killed) child.kill(isWin ? undefined : 'SIGINT')
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const cmdq = (s: string) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

/**
 * Opens an interactive terminal running `program args`. Returns an error
 * message, or null on success.
 */
export function openTerminal(title: string, program: string, args: string[]): string | null {
  const exe = which(program) ?? program
  if (process.platform === 'darwin') {
    // A .command file opens in Terminal without needing Automation permission.
    const file = join(tmpdir(), `ax-studio-${title.replace(/[^\w-]/g, '_')}.command`)
    writeFileSync(file, `#!/bin/zsh -l\nclear\necho ${shq('→ ' + title)}\n${[exe, ...args].map(shq).join(' ')}\n`)
    chmodSync(file, 0o755)
    spawn('open', [file], { detached: true, stdio: 'ignore' }).unref()
    return null
  }
  if (isWin) {
    const line = [exe, ...args].map(cmdq).join(' ')
    const wt = which('wt')
    const child = wt
      ? spawn(wt, ['new-tab', '--title', title, 'cmd', '/k', line], { detached: true, stdio: 'ignore', env })
      : spawn('cmd.exe', ['/c', 'start', `"${title}"`, 'cmd', '/k', line], { detached: true, stdio: 'ignore', env, shell: false })
    child.unref()
    return null
  }
  const line = `${[exe, ...args].map(shq).join(' ')}; echo; read -p 'Press enter to close' _`
  const candidates: [string, string[]][] = [
    ['x-terminal-emulator', ['-e', 'bash', '-c', line]],
    ['gnome-terminal', ['--title', title, '--', 'bash', '-c', line]],
    ['konsole', ['-p', `tabtitle=${title}`, '-e', 'bash', '-c', line]],
    ['xfce4-terminal', ['--title', title, '-x', 'bash', '-c', line]],
    ['kitty', ['--title', title, 'bash', '-c', line]],
    ['alacritty', ['-t', title, '-e', 'bash', '-c', line]],
    ['xterm', ['-T', title, '-e', 'bash', '-c', line]],
  ]
  for (const [term, targs] of candidates) {
    const p = which(term)
    if (p) {
      spawn(p, targs, { detached: true, stdio: 'ignore', env }).unref()
      return null
    }
  }
  return 'No terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xterm, …)'
}

/**
 * A kubeconfig that only sets current-context, prepended to KUBECONFIG, so
 * kubectl calls in the Makefile hit the chosen cluster without changing the
 * user's global context.
 */
export function kubeconfigFor(context: string): string {
  const file = join(tmpdir(), `axstudio-kubeconfig-${context.replace(/[^\w.-]/g, '_')}.yaml`)
  writeFileSync(file, `apiVersion: v1\nkind: Config\ncurrent-context: ${JSON.stringify(context)}\n`)
  const base = process.env.KUBECONFIG || join(home, '.kube', 'config')
  return [file, base].join(delimiter)
}
