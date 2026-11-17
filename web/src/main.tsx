import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { connect } from './ws'
import './styles/tokens.css'
import './styles/base.css'
import './styles/layout.css'
import './styles/views.css'
import './styles/board.css'
import './styles/chat.css'

connect()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
