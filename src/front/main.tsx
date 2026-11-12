import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('sem #root no index.html')

// Sem StrictMode duplo no terminal: o remount do StrictMode em dev abriria e
// fecharia o WebSocket duas vezes por agente, poluindo o teste do checkpoint 1.
createRoot(root).render(
  import.meta.env.DEV ? (
    <App />
  ) : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
)
