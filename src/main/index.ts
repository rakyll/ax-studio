import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import * as sh from './shell'
import type { RunRequest, StreamRequest } from '../shared/api'

const isMac = process.platform === 'darwin'
let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'AX Studio',
    show: false,
    backgroundColor: '#00000000',
    // Native traffic lights inset into our own title bar on macOS; standard frame elsewhere.
    ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 }, vibrancy: 'sidebar' } : {}),
    icon: join(__dirname, '../../build-resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win?.show())
  // Links open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  // `--section=board` opens a specific page (handy for scripted screenshots).
  const section = process.argv.find((a) => a.startsWith('--section='))?.slice(10)
  const query: Record<string, string> = section ? { section } : {}
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL + (section ? `?section=${section}` : ''))
  else win.loadFile(join(__dirname, '../renderer/index.html'), { query })
}

function send(action: string) {
  win?.webContents.send('menu', action)
}

function buildMenu() {
  const sections = ['overview', 'board', 'topology', 'designer', 'deploy', 'clusters']
  const titles = ['Overview', 'Task Board', 'Topology', 'Designer', 'Deploy', 'Clusters']
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Task Design', accelerator: 'CmdOrCtrl+N', click: () => send('new-design') },
        { label: 'Open Manifest…', accelerator: 'CmdOrCtrl+O', click: () => send('open-manifest') },
        { label: 'Save Manifest…', accelerator: 'CmdOrCtrl+S', click: () => send('save-manifest') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'AX',
      submenu: [
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => send('refresh') },
        { label: 'Apply Design', accelerator: 'CmdOrCtrl+Enter', click: () => send('apply') },
        { type: 'separator' },
        ...sections.map((s, i) => ({ label: titles[i], accelerator: `CmdOrCtrl+${i + 1}`, click: () => send(`section:${s}`) })),
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('settings') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIPC() {
  ipcMain.handle('platform', () => ({
    os: process.platform,
    home: homedir(),
    pathSeparator: delimiter,
    version: app.getVersion(),
  }))
  ipcMain.handle('run', (_e, req: RunRequest) => sh.run(req))
  ipcMain.handle('stream', (e, req: StreamRequest) => {
    sh.stream(
      req,
      (line) => !e.sender.isDestroyed() && e.sender.send('stream:line', { id: req.id, line }),
      (status) => !e.sender.isDestroyed() && e.sender.send('stream:exit', { id: req.id, status }),
    )
  })
  ipcMain.handle('cancelStream', (_e, id: string) => sh.cancel(id))
  ipcMain.handle('which', (_e, program: string) => sh.which(program))
  ipcMain.handle('openTerminal', (_e, title: string, program: string, args: string[]) => sh.openTerminal(title, program, args))
  ipcMain.handle('kubeconfigFor', (_e, context: string) => sh.kubeconfigFor(context))
  ipcMain.handle('fileExists', (_e, path: string) => existsSync(expand(path)))
  ipcMain.handle('containerRuntime', () => sh.containerRuntime(join(app.getPath('userData'), 'bin')))
  ipcMain.handle('openYAML', async (_e, defaultDir?: string) => {
    const r = await dialog.showOpenDialog(win!, {
      defaultPath: defaultDir ? expand(defaultDir) : undefined,
      filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      properties: ['openFile'],
    })
    if (r.canceled || !r.filePaths[0]) return null
    return { path: r.filePaths[0], text: readFileSync(r.filePaths[0], 'utf8') }
  })
  ipcMain.handle('saveYAML', async (_e, name: string, text: string) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: name, filters: [{ name: 'YAML', extensions: ['yaml'] }] })
    if (r.canceled || !r.filePath) return null
    writeFileSync(r.filePath, text)
    return r.filePath
  })
}

function expand(p: string) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

app.setName('AX Studio')
app.whenReady().then(() => {
  registerIPC()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('will-quit', () => sh.cancelAll())
