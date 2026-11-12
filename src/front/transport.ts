// ============================================================
// Derivado do ccanvas (https://github.com/DevoidSloth/ccanvas)
// Copyright 2026 DevoidSloth — Apache License 2.0
//
// Daqui vem a fiação do terminal: o transporte por WebSocket, o protocolo de
// controle `{ __ctl: 'resize' }` e o cuidado de só começar a streamar depois do
// chamador estar ligado, pra resposta do xterm à consulta de cursor (\x1b[6n)
// achar o caminho de volta em vez de cair no chão.
//
// O que mudou, e é a diferença que define o worldbige: aqui o pty é do daemon.
// No ccanvas, fechar o socket encerra o shell; aqui `close()` apenas desassina —
// a sessão continua viva sem cliente nenhum, e é isso que faz o scrollback
// sobreviver a fechar o navegador.
// ============================================================

export type Transport = {
  send: (data: string) => void
  resize: (cols: number, rows: number) => void
  /** desassina do stream; não encerra a sessão do outro lado */
  close: () => void
}

export type TransportHandlers = {
  onData: (chunk: string) => void
  /** o socket caiu — a sessão pode seguir viva no daemon */
  onClose: () => void
}

export function connectAgent(
  agentId: string,
  size: { cols: number; rows: number },
  h: TransportHandlers,
): Promise<Transport | null> {
  return new Promise((resolve) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url =
      `${proto}://${location.host}/ws/agents/${encodeURIComponent(agentId)}` +
      `?cols=${size.cols}&rows=${size.rows}`

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      resolve(null)
      return
    }

    let opened = false
    ws.onopen = () => {
      opened = true
      ws.send(JSON.stringify({ __ctl: 'resize', cols: size.cols, rows: size.rows }))
      resolve({
        send: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data)
        },
        resize: (cols, rows) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ __ctl: 'resize', cols, rows }))
          }
        },
        close: () => {
          ws.onclose = null
          ws.close()
        },
      })
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') h.onData(ev.data)
    }
    ws.onerror = () => {
      if (!opened) resolve(null)
    }
    ws.onclose = () => {
      if (!opened) resolve(null)
      else h.onClose()
    }
  })
}

export type AgentStatus =
  | 'starting'
  | 'running'
  | 'idle'
  | 'needs_you'
  | 'stale'
  | 'done'
  | 'stopped'
  | 'failed'

export type Agent = {
  id: string
  name: string
  cwd: string
  status: AgentStatus
  createdAt: number
  lastSignalAt: number
  exitCode: number | null
  cols: number
  rows: number
  sessionId: string | null
  /** há um pty vivo por trás deste agente? */
  live: boolean
}

export type Health = {
  ok: boolean
  reposRoot: string
  allowedRoots: string[]
  buffer: { agents: number; bytes: number }
}

export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error(`GET /api/health: ${res.status}`)
  return (await res.json()) as Health
}

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch('/api/agents')
  if (!res.ok) throw new Error(`GET /api/agents: ${res.status}`)
  return ((await res.json()) as { agents: Agent[] }).agents
}

export async function createAgent(input: { name?: string; cwd?: string }): Promise<Agent> {
  const res = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json()) as { agent?: Agent; error?: string }
  if (!res.ok || !body.agent) throw new Error(body.error || `POST /api/agents: ${res.status}`)
  return body.agent
}

export async function deleteAgent(id: string): Promise<void> {
  await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Encerra o pty e guarda a ficha — o agente fica `stopped`. */
export async function stopAgent(id: string): Promise<void> {
  await fetch(`/api/agents/${encodeURIComponent(id)}/stop`, { method: 'POST' })
}
