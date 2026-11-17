import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary, reloadForNewBuild } from './components/ErrorBoundary'
import { connect } from './ws'
import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/views.css'
import './styles/board.css'
import './styles/chat.css'
import './styles/ui.css'

connect()
// Vite's preload of a chunk failed (an older build's file is gone): reload once instead of breaking the tab.
window.addEventListener('vite:preloadError', (e) => { if (reloadForNewBuild()) e.preventDefault() })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary full>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
