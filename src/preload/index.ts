import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { StudioAPI, StreamExit, StreamLine } from '../shared/api'

function listen<T>(channel: string, cb: (v: T) => void) {
  const handler = (_e: IpcRendererEvent, v: T) => cb(v)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: StudioAPI = {
  platform: () => ipcRenderer.invoke('platform'),
  run: (req) => ipcRenderer.invoke('run', req),
  stream: (req) => ipcRenderer.invoke('stream', req),
  cancelStream: (id) => ipcRenderer.invoke('cancelStream', id),
  onStreamLine: (cb) => listen<StreamLine>('stream:line', cb),
  onStreamExit: (cb) => listen<StreamExit>('stream:exit', cb),
  which: (program) => ipcRenderer.invoke('which', program),
  openTerminal: (title, program, args) => ipcRenderer.invoke('openTerminal', title, program, args),
  kubeconfigFor: (context) => ipcRenderer.invoke('kubeconfigFor', context),
  fileExists: (path) => ipcRenderer.invoke('fileExists', path),
  openYAML: (dir) => ipcRenderer.invoke('openYAML', dir),
  saveYAML: (name, text) => ipcRenderer.invoke('saveYAML', name, text),
  onMenu: (cb) => listen<string>('menu', cb),
}

contextBridge.exposeInMainWorld('studio', api)
