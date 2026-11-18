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

export type AgentModel = 'opus' | 'sonnet' | 'haiku' | 'fable' | null

/**
 * O dropdown começa em `auto`, que quer dizer "o default do tipo de run".
 *
 * A escolha de modelo deixou de ser um gesto por agente: o normal é o tipo de
 * run e a tabela de roteamento decidirem, e escolher na mão é a exceção — que
 * continua existindo logo abaixo, e que sobrepõe tudo quando usada.
 *
 * `auto` e `padrão da conta` são coisas diferentes de propósito: a segunda é a
 * escolha explícita de não passar `--model` nenhum e deixar a configuração da
 * conta decidir.
 */
export const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'auto', label: 'auto (o default do tipo de run)' },
  { value: '', label: 'padrão da conta' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
  { value: 'fable', label: 'fable' },
]

export type AgentStatus =
  | 'starting'
  | 'awaiting_trust'
  | 'running'
  | 'idle'
  | 'needs_you'
  | 'stale'
  | 'done'
  | 'stopped'
  | 'failed'

/** A janela no canvas, em coordenadas de mundo. O dono do estado é o daemon. */
export type AgentLayout = {
  x: number
  y: number
  w: number
  h: number
  collapsed: boolean
  z: number
  /** arrastada pelo Enzo: saiu do arranjo em colchete e fica onde ele deixou */
  pinned?: boolean
}

/** O último `report` do agente — o que ELE diz de si, não a máquina de status. */
export type AgentNote = {
  status: string
  summary: string
  at: number
}

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
  model: AgentModel
  /** por que esse modelo, em uma linha; quem escreveu foi quem abriu o agente */
  modelReason: string | null
  /** a que run ele pertence */
  runId: string
  /** o tipo do run: é quem decide política, brief do lead e modelo por papel */
  runType: string
  /** o papel dado pelo lead no `spawn_helper` */
  role: string | null
  /** o último `report` dele */
  note: AgentNote | null
  /** ferramenta esperando aprovação, quando o status é `needs_you` */
  waitingTool: string | null
  layout: AgentLayout
  /** quem abriu este agente: é o colchete no canvas */
  parentId: string | null
  /** índice na paleta de identidade */
  tint: number
}

export type RunTypeOption = { id: string; label: string; hint: string }

export type Health = {
  ok: boolean
  reposRoot: string
  allowedRoots: string[]
  maxHelpers: number
  /** quais tipos de run existem; quem sabe é o daemon, que carrega as políticas */
  runTypes?: RunTypeOption[]
  buffer: { agents: number; bytes: number }
}

export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error(`GET /api/health: ${res.status}`)
  return (await res.json()) as Health
}

/**
 * Assina o canal de mudanças. É o que faz o status aparecer na hora em vez de
 * no próximo poll — e `precisa de você` só serve se acender imediatamente.
 * Devolve a função de desassinar.
 */
export function subscribeAgents(onAgents: (agents: Agent[]) => void): () => void {
  let ws: WebSocket | null = null
  let retry: number | undefined
  let closed = false

  const connect = () => {
    if (closed) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws/events`)
    } catch {
      retry = window.setTimeout(connect, 2000)
      return
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        const msg = JSON.parse(ev.data) as { type?: string; agents?: Agent[] }
        if (msg.type === 'agents' && msg.agents) onAgents(msg.agents)
      } catch {
        /* mensagem estranha — ignora */
      }
    }
    // Se o daemon cair e voltar, o canal se refaz sozinho.
    ws.onclose = () => {
      if (!closed) retry = window.setTimeout(connect, 2000)
    }
  }
  connect()

  return () => {
    closed = true
    window.clearTimeout(retry)
    try {
      if (ws) {
        ws.onclose = null
        ws.close()
      }
    } catch {
      /* já fechado */
    }
  }
}

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch('/api/agents')
  if (!res.ok) throw new Error(`GET /api/agents: ${res.status}`)
  return ((await res.json()) as { agents: Agent[] }).agents
}

export async function createAgent(input: {
  name?: string
  cwd?: string
  cols?: number
  rows?: number
  /** `auto` (o default do tipo de run), `''` (padrão da conta), ou um modelo */
  model?: string
  /** o tipo do run; só vale pro agente raiz — um helper herda o de quem o abriu */
  runType?: string
  /** o que este run é pra fazer, em uma linha; vai pro brief do lead */
  subject?: string
  /** quem abriu este agente; vira a seta no canvas */
  parentId?: string | null
  /**
   * Onde a janela já está na tela. O front manda porque a janela existe como
   * fantasma antes do agente: ela é quem mede as dimensões do terminal, e sem
   * este campo o daemon escolheria outro lugar e a janela pularia ao nascer.
   */
  layout?: Partial<AgentLayout>
}): Promise<Agent> {
  const res = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await res.json()) as { agent?: Agent; error?: string }
  if (!res.ok || !body.agent) throw new Error(body.error || `POST /api/agents: ${res.status}`)
  return body.agent
}

/**
 * Grava onde a janela ficou. Só no fim do gesto — durante o arrasto a verdade é
 * local, senão cada frame viraria uma escrita em disco.
 *
 * `z: -1` quer dizer "traz pra frente": quem decide o topo é o daemon, que é o
 * único que enxerga todas as janelas.
 */
export async function patchLayout(id: string, patch: Partial<AgentLayout>): Promise<void> {
  await fetch(`/api/agents/${encodeURIComponent(id)}/layout`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export async function deleteAgent(id: string): Promise<void> {
  await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Encerra o pty e guarda a ficha — o agente fica `stopped`. */
export async function stopAgent(id: string): Promise<void> {
  await fetch(`/api/agents/${encodeURIComponent(id)}/stop`, { method: 'POST' })
}

/** Reabre a sessão onde ela parou, com `claude --resume`. */
export async function resumeAgent(id: string): Promise<Agent> {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/resume`, { method: 'POST' })
  const body = (await res.json()) as { agent?: Agent; error?: string }
  if (!res.ok || !body.agent) throw new Error(body.error || `resume: ${res.status}`)
  return body.agent
}
