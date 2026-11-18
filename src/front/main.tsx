import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// As fontes são servidas junto com o app, não por CDN: o worldbige roda em
// localhost e precisa abrir igual com a internet fora do ar. `full` do Fraunces
// traz os eixos ópticos (opsz, SOFT, WONK) que os títulos usam.
import '@fontsource-variable/fraunces/full.css'
import '@fontsource-variable/jetbrains-mono'
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
