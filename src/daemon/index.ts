// worldbige — daemon.
//
// Um processo Node em 127.0.0.1:4317, dono dos ptys dos agentes, servindo na
// mesma porta o front buildado, a API HTTP e o WebSocket dos terminais (e, nas
// unidades seguintes, os hooks e o servidor MCP).
import http from 'node:http'
import fs from 'node:fs'
import { WebSocketServer, type WebSocket } from 'ws'
import { config } from './config.js'
import { findClaude } from './claude-bin.js'
import { handleRequest } from './http.js'
import {
  attachClient,
  resizeAgent,
  restoreAgents,
  stopAll,
  writeToAgent,
  getAgent,
} from './agents.js'
import { ensureDataDirs, flushState } from './state.js'

ensureDataDirs()
const restored = restoreAgents()

const server = http.createServer((req, res) => {
  void handleRequest(req, res)
})

// ---------- terminais ----------
// `noServer` em vez de `{ server }`: o upgrade passa pelo roteamento, então
// /ws/agents/<id> é a única rota que vira WebSocket.
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`)
  const match = /^\/ws\/agents\/([^/]+)$/.exec(url.pathname)
  if (!match) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  const id = match[1] as string
  if (!getAgent(id)) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, id, url))
})

function attach(ws: WebSocket, id: string, url: URL): void {
  const cols = Number(url.searchParams.get('cols'))
  const rows = Number(url.searchParams.get('rows'))
  // Só mexe no tamanho se o cliente realmente trouxe outro: `resizeAgent` já
  // ignora um resize igual ao vigente, e é isso que impede o redesenho inútil
  // da TUI a cada reconexão.
  if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 1 && rows > 1) {
    resizeAgent(id, cols, rows, 'attach')
  }

  const unsubscribe = attachClient(id, (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk)
  })
  if (!unsubscribe) {
    ws.close(1011, 'agente não encontrado')
    return
  }

  if (!getAgent(id)?.live && ws.readyState === ws.OPEN) {
    ws.send('\r\n\x1b[2m[worldbige] sessão parada. O resume chega na unidade 2.\x1b[0m\r\n')
  }

  ws.on('message', (raw) => {
    const msg = raw.toString()
    // Controle vem como JSON; o resto é teclado cru indo pro pty.
    if (msg.startsWith('{')) {
      try {
        const ctl = JSON.parse(msg) as { __ctl?: string; cols?: number; rows?: number }
        if (ctl.__ctl === 'resize') {
          // Passo único: o front já mandou colunas e linhas calculadas, o daemon
          // aplica no pty na mesma mensagem — nunca em dois momentos.
          resizeAgent(id, Number(ctl.cols), Number(ctl.rows), 'ws')
          return
        }
      } catch {
        /* não era controle — segue como entrada */
      }
    }
    writeToAgent(id, msg)
  })

  // Desligar o assinante é tudo que acontece aqui: o pty é do daemon e segue
  // vivo sem cliente nenhum. Nada de kill, nada de sinal.
  ws.on('close', () => unsubscribe())
  ws.on('error', () => unsubscribe())
}

// ---------- ciclo de vida ----------
let closing = false
function shutdown(signal: string): void {
  if (closing) return
  closing = true
  console.log(`\n${signal} — encerrando os agentes e saindo.`)
  stopAll()
  // O estado tem que estar no disco antes de sair: é dele que os cards voltam
  // `stopped` no próximo boot, com o sessionId que o resume usa.
  void flushState().finally(() => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => shutdown(sig))

server.listen(config.port, config.host, () => {
  console.log('✦ worldbige daemon')
  console.log(`  http + ws   http://${config.host}:${config.port}`)
  try {
    console.log(`  claude      ${findClaude().resolved}`)
  } catch (err) {
    console.log(`  claude      NÃO ENCONTRADO — ${err instanceof Error ? err.message : err}`)
  }
  console.log(`  repos       ${config.reposRoot}`)
  console.log(`  dados       ${config.dataDir}`)
  console.log(`  front       ${fs.existsSync(config.frontDir) ? config.frontDir : '(sem build)'}`)
  if (restored) console.log(`  restaurados ${restored} agente(s) do estado, como stopped`)
  console.log('  pronto.\n')
})
