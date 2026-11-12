// O registro de agentes. Um agente é uma sessão interativa do `claude` num pty.
//
// A regra que define este arquivo: o pty pertence ao daemon, nunca à conexão.
// Um WebSocket é só um assinante do stream — fechar o navegador não mata nem
// sinaliza a sessão. É exatamente a inversão do backend web do ccanvas, onde o
// shell morre junto com o socket.
//
// O scrollback não é um log de bytes, é uma TELA. Cada agente tem um xterm
// headless aqui no daemon, alimentado pelo pty; ao conectar, o cliente recebe o
// estado serializado dessa tela, não o histórico cru. Guardar bytes crus não
// funciona com uma TUI: o Claude redesenha a tela inteira o tempo todo, então
// repetir o histórico empilha uma cópia do desenho a cada reconexão.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn as spawnPty, type IPty } from '@lydell/node-pty'
import type {
  Terminal as XTerm,
  ITerminalOptions,
  ITerminalInitOnlyOptions,
} from '@xterm/headless'
import type { SerializeAddon as XSerializeAddon } from '@xterm/addon-serialize'
import { config } from './config.js'
import { findClaude } from './claude-bin.js'
import { resolveAgentCwd } from './cwd.js'
import { loadState, saveState, type PersistedAgent, type State } from './state.js'
import { isTrusted } from './trust.js'
import { emitAgentsChanged } from './events.js'
import { removeAgentSettings, writeAgentSettings } from './hook-settings.js'
import { applyHookEvent, markIfStale, noteUserInput, type HookEvent } from './status.js'

// Os dois pacotes são CommonJS e o daemon é ESM: o Node não enxerga os named
// exports deles, então o require explícito é o que funciona. Os tipos vêm por
// `import type`, que some na compilação.
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as {
  Terminal: new (options?: ITerminalOptions & ITerminalInitOnlyOptions) => XTerm
}
const { SerializeAddon } = require('@xterm/addon-serialize') as {
  SerializeAddon: new () => XSerializeAddon
}

export type AgentStatus =
  | 'starting'
  /** a pasta nunca foi confiada: a sessão está parada na tela de trust */
  | 'awaiting_trust'
  | 'running'
  | 'idle'
  | 'needs_you'
  | 'stale'
  | 'done'
  | 'stopped'
  | 'failed'

/** Os modelos que o front oferece. `null` = padrão da conta (não passa `--model`). */
export type AgentModel = 'opus' | 'sonnet' | 'haiku' | 'fable' | null

const MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable'])

export function parseModel(value: unknown): AgentModel {
  return typeof value === 'string' && MODELS.has(value) ? (value as AgentModel) : null
}

/**
 * A janela do agente no canvas, em coordenadas de mundo (antes do zoom).
 *
 * É estado do daemon e não do front: o front é descartável por desenho, então
 * arrastar uma janela e recarregar a aba não pode desfazer o arrasto.
 */
export type AgentLayout = {
  x: number
  y: number
  w: number
  h: number
  /** recolhida vira card com status e último resumo */
  collapsed: boolean
  /** ordem de empilhamento; clicar numa janela a traz pra frente */
  z: number
}

/** Quantas tintas de identidade existem. O front tem a paleta correspondente. */
export const TINT_COUNT = 6

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
  live: boolean
  /** modelo pedido no spawn; null = padrão da conta */
  model: AgentModel
  /** ferramenta esperando aprovação, quando o status é `needs_you` */
  waitingTool: string | null
  /** posição e tamanho da janela no canvas */
  layout: AgentLayout
  /** quem abriu este agente; vira a seta lead→helper no canvas */
  parentId: string | null
  /** índice na paleta de identidade: ponto na gaveta, linha e fio da janela */
  tint: number
}

type Subscriber = (chunk: string) => void

type Live = {
  agent: Agent
  pty: IPty | null
  subscribers: Set<Subscriber>
  /** a tela do agente, mantida no servidor */
  term: XTerm
  serializer: XSerializeAddon
  /** nós pedimos o encerramento — ver `stopAgent` */
  stopping: boolean
}

const agents = new Map<string, Live>()

// ---------- lugar no canvas ----------
// Um agente que nasce em cima do anterior obriga a arrastar antes de usar, então
// o daemon já o coloca onde a leitura do run é a natural: helper abaixo de quem
// o abriu, irmão à direita do irmão anterior, raiz à direita da última raiz.

const WIN_W = 840
const WIN_H = 620
const GAP_X = 72
const GAP_Y = 120

function placeAgent(parentId: string | null): { x: number; y: number } {
  const all = [...agents.values()].map((l) => l.agent)
  const parent = parentId ? all.find((a) => a.id === parentId) : undefined

  if (parent) {
    const siblings = all.filter((a) => a.parentId === parent.id)
    const y = parent.layout.y + parent.layout.h + GAP_Y
    if (!siblings.length) return { x: parent.layout.x, y }
    // Irmão vai à direita do irmão mais à direita, na mesma faixa.
    const rightmost = siblings.reduce((m, a) => Math.max(m, a.layout.x + a.layout.w), -Infinity)
    return { x: rightmost + GAP_X, y }
  }

  const roots = all.filter((a) => !a.parentId)
  if (!roots.length) return { x: 0, y: 0 }
  const rightmost = roots.reduce((m, a) => Math.max(m, a.layout.x + a.layout.w), -Infinity)
  return { x: rightmost + GAP_X, y: roots[0]?.layout.y ?? 0 }
}

/** A tinta livre mais baixa; só repete quando a paleta se esgota. */
function nextTint(): number {
  const used = new Set([...agents.values()].map((l) => l.agent.tint))
  for (let i = 0; i < TINT_COUNT; i++) if (!used.has(i)) return i
  return agents.size % TINT_COUNT
}

function topZ(): number {
  let z = 0
  for (const l of agents.values()) z = Math.max(z, l.agent.layout.z)
  return z
}

/**
 * Move, redimensiona, recolhe ou traz pra frente — o que o arrasto do front
 * produziu. Só persiste se algo mudou mesmo: arrastar emite muitos eventos.
 */
export function setLayout(id: string, patch: Partial<AgentLayout>): Agent | null {
  const live = agents.get(id)
  if (!live) return null
  const before = live.agent.layout
  const next: AgentLayout = {
    x: Number.isFinite(patch.x) ? (patch.x as number) : before.x,
    y: Number.isFinite(patch.y) ? (patch.y as number) : before.y,
    w: Number.isFinite(patch.w) ? Math.max(360, patch.w as number) : before.w,
    h: Number.isFinite(patch.h) ? Math.max(180, patch.h as number) : before.h,
    collapsed: typeof patch.collapsed === 'boolean' ? patch.collapsed : before.collapsed,
    // `z: -1` é o pedido de "traz pra frente" sem o front saber o topo atual.
    z: patch.z === -1 ? topZ() + 1 : Number.isFinite(patch.z) ? (patch.z as number) : before.z,
  }
  const same =
    next.x === before.x &&
    next.y === before.y &&
    next.w === before.w &&
    next.h === before.h &&
    next.collapsed === before.collapsed &&
    next.z === before.z
  if (same) return live.agent
  live.agent.layout = next
  persist()
  return live.agent
}

/**
 * O ambiente de um agente, sem os marcadores da sessão que abriu o daemon.
 *
 * Se o worldbige for iniciado de dentro de uma sessão do Claude Code, o pty
 * herdaria `CLAUDE_CODE_CHILD_SESSION` e o agente nasceria marcado como filho
 * daquela sessão: o Claude Code desliga a persistência de transcript nesse
 * caso, e sem transcript não existe `--resume` — ou seja, a unidade 2 morre
 * silenciosamente. `CLAUDE_CODE_MESSAGING_SOCKET` e `_TOKEN` são piores: dariam
 * ao agente um canal de volta pra sessão que o abriu.
 *
 * Cada agente é uma sessão de primeira classe, não filha de ninguém.
 */
function agentEnv(): Record<string, string> {
  const drop = new Set([
    'CLAUDECODE',
    'CLAUDE_PID',
    'CLAUDE_EFFORT',
    'CLAUDE_AGENT_SDK_VERSION',
    'claude',
  ])
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('CLAUDE_CODE_')) continue
    if (drop.has(key)) continue
    env[key] = value
  }
  return env
}

function makeScreen(cols: number, rows: number): { term: XTerm; serializer: XSerializeAddon } {
  const term = new Terminal({
    cols,
    rows,
    scrollback: config.scrollbackLines,
    allowProposedApi: true,
  })
  const serializer = new SerializeAddon()
  // Os tipos do addon são escritos contra `@xterm/xterm` (o Terminal do
  // navegador), não contra o headless, embora a API que ele usa seja a mesma e
  // o runtime case — está verificado. O cast fica preso nesta linha.
  term.loadAddon(serializer as unknown as Parameters<XTerm["loadAddon"]>[0])
  return { term, serializer }
}

// ---------- persistência ----------

function persist(): void {
  const snapshot: State = {
    version: 1,
    agents: [...agents.values()].map(({ agent }) => ({
      id: agent.id,
      name: agent.name,
      cwd: agent.cwd,
      // Um pty vivo não sobrevive ao daemon: no arquivo ele já vale como parado.
      // `done` resiste, porque é conclusão registrada, não estado de processo.
      status: agent.status === 'done' ? 'done' : agent.live ? 'stopped' : agent.status,
      createdAt: agent.createdAt,
      lastSignalAt: agent.lastSignalAt,
      exitCode: agent.exitCode,
      cols: agent.cols,
      rows: agent.rows,
      sessionId: agent.sessionId,
      model: agent.model,
      layout: agent.layout,
      parentId: agent.parentId,
      tint: agent.tint,
    })),
  }
  saveState(snapshot)
  // O front é avisado na hora; sem isso o status só aparece no próximo poll.
  emitAgentsChanged()
}

export function restoreAgents(): number {
  const state = loadState()
  let index = 0
  for (const p of state.agents) {
    if (agents.has(p.id)) continue
    const { term, serializer } = makeScreen(p.cols, p.rows)
    agents.set(p.id, {
      agent: toAgent(p, index++),
      pty: null,
      subscribers: new Set(),
      term,
      serializer,
      stopping: false,
    })
  }
  return state.agents.length
}

function toAgent(p: PersistedAgent, index: number): Agent {
  return {
    id: p.id,
    name: p.name,
    cwd: p.cwd,
    // O pty morreu com o daemon; o resume (unidade 2) é que reabre. `done` é a
    // exceção: vem do tool MCP e rebaixá-lo apagaria o que o agente fez.
    status: p.status === 'done' ? 'done' : 'stopped',
    createdAt: p.createdAt,
    lastSignalAt: p.lastSignalAt,
    exitCode: p.exitCode,
    cols: p.cols,
    rows: p.rows,
    sessionId: p.sessionId ?? null,
    live: false,
    model: p.model ?? null,
    waitingTool: null,
    // Estado gravado antes da unidade 3 não tem lugar no canvas: em vez de
    // empilhar todo mundo na origem, a ficha velha entra numa fileira.
    layout: p.layout ?? {
      x: index * (WIN_W + GAP_X),
      y: 0,
      w: WIN_W,
      h: WIN_H,
      collapsed: false,
      z: index,
    },
    parentId: p.parentId ?? null,
    tint: typeof p.tint === 'number' ? p.tint : index % TINT_COUNT,
  }
}

// ---------- ciclo de vida ----------

export type SpawnOptions = {
  name?: string
  cwd?: string
  cols?: number
  rows?: number
  model?: AgentModel
  args?: string[]
  /** política de permissão do run type (unidade 5) */
  permissions?: Record<string, unknown>
  /** quem abriu este agente; vira a seta no canvas (o `after` da unidade 4) */
  parentId?: string | null
  /** lugar no canvas; sem isso o daemon escolhe (abaixo do pai, à direita do irmão) */
  layout?: Partial<AgentLayout>
  /** tinta de identidade; sem isso pega a primeira livre */
  tint?: number
}

export function createAgent(opts: SpawnOptions = {}): Agent {
  const launch = findClaude()
  // Recusa antes de abrir nada: cwd fora das raízes permitidas não vira sessão.
  const cwd = resolveAgentCwd(opts.cwd)
  const id = randomUUID()
  const cols = opts.cols && opts.cols > 1 ? Math.floor(opts.cols) : 100
  const rows = opts.rows && opts.rows > 1 ? Math.floor(opts.rows) : 30
  const model = opts.model ?? null

  // A tela de confiança aparece antes de qualquer hook: se a pasta nunca foi
  // aceita, o card já nasce dizendo isso em vez de mentir `starting`.
  const trusted = isTrusted(cwd)

  // Um pai que não existe mais não vira seta pendurada no vazio.
  const parentId = opts.parentId && agents.has(opts.parentId) ? opts.parentId : null
  const spot = placeAgent(parentId)
  const layout: AgentLayout = {
    x: opts.layout?.x ?? spot.x,
    y: opts.layout?.y ?? spot.y,
    w: opts.layout?.w ?? WIN_W,
    h: opts.layout?.h ?? WIN_H,
    collapsed: opts.layout?.collapsed ?? false,
    z: opts.layout?.z ?? topZ() + 1,
  }

  const agent: Agent = {
    id,
    name: opts.name?.trim() || `agente-${id.slice(0, 4)}`,
    cwd,
    status: trusted === false ? 'awaiting_trust' : 'starting',
    createdAt: Date.now(),
    lastSignalAt: Date.now(),
    exitCode: null,
    cols,
    rows,
    sessionId: null,
    live: true,
    model,
    waitingTool: null,
    layout,
    parentId,
    tint: typeof opts.tint === 'number' ? opts.tint : nextTint(),
  }

  const { term, serializer } = makeScreen(cols, rows)
  const live: Live = { agent, pty: null, subscribers: new Set(), term, serializer, stopping: false }

  // Os hooks sobem com a sessão: sem o --settings o agente é um terminal cego.
  const settingsFile = writeAgentSettings(id, opts.permissions ? { permissions: opts.permissions } : {})
  const args = [
    ...launch.prefix,
    '--settings',
    settingsFile,
    ...(model ? ['--model', model] : []),
    ...(opts.args ?? []),
  ]

  const pty = spawnPty(launch.file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: agentEnv(),
  })
  live.pty = pty
  agents.set(id, live)

  pty.onData((chunk) => {
    // A tela do servidor primeiro, o stream vivo depois. A ordem importa: quem
    // conectar agora recebe o snapshot já com este pedaço aplicado.
    live.term.write(chunk)
    for (const send of live.subscribers) send(chunk)
  })

  pty.onExit(({ exitCode }) => {
    live.pty = null
    agent.live = false
    agent.exitCode = exitCode
    // Encerramento que nós pedimos é `stopped`, qualquer que seja o código.
    agent.status = live.stopping || exitCode === 0 ? 'stopped' : 'failed'
    agent.lastSignalAt = Date.now()
    persist()
  })

  persist()
  console.log(
    `+ agente ${agent.name} (${id.slice(0, 8)}) ${cols}x${rows} modelo=${model ?? 'conta'} cwd=${cwd}` +
      (trusted === false ? '  [pasta não confiada — a sessão vai parar na tela de trust]' : ''),
  )
  return agent
}

/**
 * Reabre uma sessão parada onde ela estava, com `claude --resume <session_id>`.
 *
 * Os ptys morrem com o daemon; o transcript não, porque o Claude Code o
 * persiste por conta própria. O `session_id` guardado é o que liga uma coisa na
 * outra. Sem ele não há o que resumir.
 */
export function resumeAgent(id: string): Agent | null {
  const live = agents.get(id)
  if (!live) return null
  const old = live.agent
  if (old.live) return old // já está de pé
  if (!old.sessionId) return null

  const resumed = createAgent({
    name: old.name,
    cwd: old.cwd,
    cols: old.cols,
    rows: old.rows,
    model: old.model,
    args: ['--resume', old.sessionId],
    // A janela não pode pular de lugar só porque a sessão reabriu: o canvas é
    // memória espacial, e um card que se move sozinho apaga o que você lembrava.
    layout: old.layout,
    parentId: old.parentId,
    tint: old.tint,
  })
  // A ficha nova herda a identidade da antiga: pro front é o mesmo agente
  // voltando, não um segundo card.
  resumed.sessionId = old.sessionId
  // Os filhos apontavam pro id antigo; sem isto as setas deles ficariam penduradas
  // num agente que não existe mais.
  for (const l of agents.values()) {
    if (l.agent.parentId === id) l.agent.parentId = resumed.id
  }
  removeAgent(id)
  persist()
  console.log(`↻ agente ${resumed.name} resumido de ${old.sessionId.slice(0, 8)}`)
  return resumed
}

/** Entrega um evento de hook à máquina de status. */
export function handleHookEvent(id: string, event: HookEvent): boolean {
  const live = agents.get(id)
  if (!live) return false
  const before = live.agent.status
  const { changed, ended } = applyHookEvent(live.agent, event)
  console.log(
    `  hook ${new Date().toISOString().slice(11, 23)} ${live.agent.name} ${event.hook_event_name ?? '?'}` +
      (event.source ? ` source=${event.source}` : '') +
      (event.notification_type ? ` type=${event.notification_type}` : '') +
      (event.reason ? ` reason=${event.reason}` : '') +
      (event.tool_name ? ` tool=${event.tool_name}` : '') +
      (before !== live.agent.status ? `  ${before} → ${live.agent.status}` : ''),
  )
  if (ended) {
    // A sessão se despediu; o pty vai junto, mas a ficha fica.
    live.stopping = true
    if (live.pty) {
      try {
        live.pty.kill()
      } catch {
        /* já morreu */
      }
    }
    live.pty = null
  }
  if (changed || ended) persist()
  return true
}

/** O watchdog do `stale`: silêncio além do limite é sinal perdido. */
export function sweepStale(limitMs = config.staleMs): number {
  let marked = 0
  for (const live of agents.values()) {
    if (markIfStale(live.agent, limitMs)) {
      marked++
      console.log(`  ${live.agent.name} → stale (sem sinal há ${Math.round(limitMs / 1000)}s)`)
    }
  }
  if (marked) persist()
  return marked
}

export function listAgents(): Agent[] {
  return [...agents.values()].map((l) => l.agent)
}

export function getAgent(id: string): Agent | null {
  return agents.get(id)?.agent ?? null
}

/**
 * Liga um cliente ao agente: ele recebe a tela serializada e, em seguida, o
 * stream vivo.
 *
 * A troca é feita sem buraco e sem repetição. O assinante entra já na fila, e
 * um `write` vazio marca o ponto do snapshot: o xterm processa as escritas em
 * ordem, então tudo que chegar depois desta linha cai na fila e NÃO entra no
 * snapshot. Quando o callback roda, a fila é drenada por cima da tela e o
 * assinante passa a escrever direto.
 */
export function attachClient(id: string, send: Subscriber): (() => void) | null {
  const live = agents.get(id)
  if (!live) return null

  let ready = false
  const queued: string[] = []
  const subscriber: Subscriber = (chunk) => {
    if (ready) send(chunk)
    else queued.push(chunk)
  }
  live.subscribers.add(subscriber)

  live.term.write('', () => {
    // Daqui pra baixo é tudo síncrono: nada do pty se intromete no meio.
    try {
      const screen = live.serializer.serialize()
      if (screen) send(screen)
    } catch (err) {
      console.error('falhou serializar a tela:', err instanceof Error ? err.message : err)
    }
    for (const chunk of queued) send(chunk)
    queued.length = 0
    ready = true
  })

  return () => {
    live.subscribers.delete(subscriber)
  }
}

export function writeToAgent(id: string, data: string): boolean {
  const live = agents.get(id)
  if (!live?.pty) return false
  // Responder um prompt de permissão é a única saída de `needs_you` que
  // existe: a rejeição não gera hook nenhum.
  if (noteUserInput(live.agent, data)) persist()
  live.pty.write(data)
  return true
}

/**
 * Redimensiona o pty e a tela do servidor — e só se as dimensões mudaram
 * mesmo. Um resize redundante faz a TUI redesenhar a tela inteira, que era
 * metade da causa do scrollback duplicado: cada reconexão mandava um resize
 * igual ao que já estava valendo, o Claude repintava, e o replay trazia mais
 * uma cópia do desenho.
 */
export function resizeAgent(id: string, cols: number, rows: number, origin = '?'): boolean {
  const live = agents.get(id)
  if (!live) return false
  const c = Math.max(2, Math.floor(cols))
  const r = Math.max(2, Math.floor(rows))
  if (!Number.isFinite(c) || !Number.isFinite(r)) return false

  // Todo resize que chega é registrado, inclusive o que a gente ignora: um
  // redesenho da TUI só acontece quando as dimensões mudam de verdade, então
  // este log é a prova de onde vêm os desenhos empilhados.
  const stamp = new Date().toISOString().slice(11, 23)
  const tag = `${live.agent.name}(${id.slice(0, 8)})`

  if (live.agent.cols === c && live.agent.rows === r) {
    console.log(`  resize ${stamp} ${tag} ${c}x${r} via:${origin} — IGNORADO (igual)`)
    return false
  }

  console.log(
    `  resize ${stamp} ${tag} ${live.agent.cols}x${live.agent.rows} → ${c}x${r} via:${origin} — APLICADO`,
  )
  // A tela do servidor e o pty andam juntos, na mesma chamada: se divergirem,
  // o snapshot é desenhado num tamanho e o pty escreve noutro.
  live.term.resize(c, r)
  live.pty?.resize(c, r)
  live.agent.cols = c
  live.agent.rows = r
  return true
}

/** Encerra o pty mas mantém a ficha: o agente vira `stopped`, não some. */
export function stopAgent(id: string): boolean {
  const live = agents.get(id)
  if (!live) return false
  if (live.pty) {
    live.stopping = true
    try {
      live.pty.kill()
    } catch {
      /* já morreu */
    }
  }
  live.pty = null
  live.agent.live = false
  live.agent.status = 'stopped'
  live.agent.lastSignalAt = Date.now()
  persist()
  return true
}

/** Apaga o agente de vez — ficha, tela e pty. */
export function removeAgent(id: string): boolean {
  const live = agents.get(id)
  if (!live) return false
  stopAgent(id)
  // Quem dependia dele passa a depender de quem o abriu: a cadeia encurta em vez
  // de arrebentar, e nenhuma seta fica apontando pro vazio.
  for (const other of agents.values()) {
    if (other.agent.parentId === id) other.agent.parentId = live.agent.parentId
  }
  for (const send of live.subscribers) {
    send('\r\n\x1b[2m[worldbige] agente removido.\x1b[0m\r\n')
  }
  live.subscribers.clear()
  live.term.dispose()
  removeAgentSettings(id)
  agents.delete(id)
  persist()
  console.log(`- agente ${live.agent.name} (${id.slice(0, 8)}) removido`)
  return true
}

export function stopAll(): void {
  for (const id of agents.keys()) stopAgent(id)
}

/** Diagnóstico, pro health check. */
export function screenStats(): { agents: number; bytes: number } {
  let bytes = 0
  for (const live of agents.values()) {
    try {
      bytes += live.serializer.serialize().length
    } catch {
      /* tela indisponível */
    }
  }
  return { agents: agents.size, bytes }
}
