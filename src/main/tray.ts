import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { TraySummary } from '../shared/api'
import icon from './assets/trayTemplate.png?inline'
import icon2x from './assets/trayTemplate@2x.png?inline'

/** Tasks listed per phase before the rest are left to the Activity page. */
const MAX_PER_PHASE = 15

export interface TrayHandlers {
  /** Sends a menu action to the window, opening it if needed and bringing it forward if `show`. */
  act: (action: string, show?: boolean) => void
  quit: () => void
}

let tray: Tray | null = null
let handlers: TrayHandlers
let last: TraySummary | null = null

/** The menu bar icon: the Activity page in brief, with the same task actions. */
export function createTray(h: TrayHandlers) {
  handlers = h
  const image = nativeImage.createFromDataURL(icon)
  image.addRepresentation({ scaleFactor: 2, dataURL: icon2x })
  image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('AX Studio')
  render()
}

export function updateTray(summary: TraySummary | null) {
  last = summary
  render()
}

function render() {
  if (!tray) return
  const s = last
  const items: MenuItemConstructorOptions[] = []
  if (!s) {
    items.push({ label: 'Open AX Studio to see tasks', enabled: false })
  } else {
    items.push({ label: s.scope, enabled: false }, { label: s.status, enabled: false })
    for (const g of s.groups) {
      items.push({ type: 'separator' }, { label: g.phase, enabled: false })
      for (const t of g.tasks.slice(0, MAX_PER_PHASE)) {
        items.push({
          label: t.name,
          submenu: [
            { label: 'Show in Activity', click: () => handlers.act(`tray:show:${t.name}`) },
            ...t.actions.map((a) => ({
              label: a === 'resume' ? 'Resume' : 'Suspend',
              click: () => handlers.act(`tray:${a}:${t.name}`, false),
            })),
          ],
        })
      }
      const more = g.tasks.length - MAX_PER_PHASE
      if (more > 0) items.push({ label: `${more} more…`, click: () => handlers.act('section:overview') })
    }
  }
  items.push(
    { type: 'separator' },
    { label: 'Open Activity', click: () => handlers.act('section:overview') },
    { label: 'Refresh', enabled: !!s, click: () => handlers.act('refresh') },
    { type: 'separator' },
    { label: 'Quit AX Studio', click: () => handlers.quit() },
  )
  tray.setContextMenu(Menu.buildFromTemplate(items))
}
