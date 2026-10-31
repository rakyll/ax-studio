import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/base.css'

document.documentElement.dataset.os = navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent.includes('Windows') ? 'win32' : 'linux'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
