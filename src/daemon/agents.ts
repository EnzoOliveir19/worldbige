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
import { removeAgentMcpConfig, writeAgentMcpConfig } from './mcp-config.js'
import { appendHookLog, newRunId, summarize, writeLeadBrief } from './runs.js'
import {
  DEFAULT_RUN_TYPE,
  defaultModelForRole,
  isRunTypeId,
  leadBrief,
  runType,
  type RunTypeId,
} from './run-types.js'
import {
  clear as outboxClear,
  enqueue as outboxEnqueue,
  noteTyping,
  peek as outboxPeek,
  pending as outboxPending,
  shift as outboxShift,
  typingRecently,
  unshift as outboxUnshift,
  type OutgoingKind,
} from './outbox.js'
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
  /**
   * O Enzo arrastou esta janela, então ela saiu do arranjo automático.
   *
   * O arranjo é bom pro que o daemon abre sozinho e péssimo pro que a pessoa
   * decidiu: uma janela que você moveu e que o próximo helper empurra de volta
   * é uma janela que você não pode mover. Arrastar é o gesto que fixa.
   */
  pinned?: boolean
}

/**
 * O último `report` do agente — o que ELE diz de si.
 *
 * Deliberadamente não é `AgentStatus`: a máquina de status é a tabela do TDD e
 * nada fora dela escreve nela. Isto é uma nota, escrita pelo próprio agente, e
 * é o que o card recolhido mostra quando a janela está fechada.
 */
export type AgentNote = {
  /** uma palavra do próprio agente: `trabalhando`, `travado`, o que ele quiser */
  status: string
  summary: string
  at: number
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
  /**
   * Por que esse modelo, em uma linha.
   *
   * Sem isto, "por que esse helper está em opus" vira arqueologia de
   * transcript: o lead escolhe o modelo por uma tabela de roteamento, e a
   * escolha só é auditável se o motivo vier junto e aparecer no cabeçalho.
   */
  modelReason: string | null
  /** a que run este agente pertence; é a pasta onde o que ele produz fica */
  runId: string
  /**
   * O tipo do run: quem decide a política de permissão desta sessão, o brief
   * que o lead recebe e o modelo default de cada papel.
   */
  runType: RunTypeId
  /** o papel dado pelo lead no `spawn_helper` */
  role: string | null
  /** o último `report` do próprio agente */
  note: AgentNote | null
  /** ferramenta esperando aprovação, quando o status é `needs_you` */
  waitingTool: string | null
  /** posição e tamanho da janela no canvas */
  layout: AgentLayout
  /** quem abriu este agente; vira o colchete lead→helper no canvas */
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
//
// O arranjo é um colchete, não um amontoado: os helpers de um agente nascem
// numa coluna à direita dele, empilhados de cima pra baixo e alinhados pelo
// topo com quem os abriu. Helpers de helper repetem a regra uma coluna mais à
// direita, então a profundidade da delegação se lê na horizontal e a largura do
// fan-out na vertical — de longe, afastado, o desenho do run é a própria forma.
//
// A regra vale pro que o daemon abre sozinho. Uma janela arrastada pelo Enzo
// ganha `pinned` e sai do arranjo: ela fica onde ele deixou, e os helpers dela
// seguem ela até lá.

const WIN_W = 840
const WIN_H = 620
/** Entre uma coluna e a seguinte. É onde o tronco do colchete é desenhado. */
const COL_GAP = 120
/** Entre dois irmãos empilhados. Fixo: a coluna tem que ler como uma lista. */
const ROW_GAP = 48
/** Entre uma raiz e a raiz seguinte, com a subárvore inteira no meio. */
const RUN_GAP = 220

/**
 * Altura do card recolhido. Igual à do front, de propósito — ver `relayout`:
 * quem empilha a coluna é o daemon, e ele precisa saber a altura de verdade de
 * cada janela, senão recolher uma deixa um buraco na pilha.
 */
const CARD_H = 108

function heightOf(agent: Agent): number {
  return agent.layout.collapsed ? CARD_H : agent.layout.h
}

/** Os filhos de um agente, na ordem em que foram abertos. */
function childrenOf(all: Agent[], id: string): Agent[] {
  return all.filter((a) => a.parentId === id).sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Recoloca todo mundo que ainda está no arranjo automático.
 *
 * Roda a cada mudança que mexe na forma da árvore (agente novo, agente que
 * saiu, janela recolhida): a coluna de helpers é uma pilha, e uma pilha que não
 * se refaz deixa buraco onde alguém saiu.
 *
 * Raízes não são tocadas — a posição de um lead é dele, seja porque o front a
 * escolheu ao abrir, seja porque o Enzo a arrastou.
 */
function relayout(): boolean {
  const all = [...agents.values()].map((l) => l.agent)
  let moved = false

  const walk = (parent: Agent): void => {
    const children = childrenOf(all, parent.id)
    if (!children.length) return
    const columnX = Math.round(parent.layout.x + parent.layout.w + COL_GAP)
    let y = parent.layout.y

    for (const child of children) {
      if (!child.layout.pinned) {
        if (child.layout.x !== columnX || child.layout.y !== Math.round(y)) {
          child.layout = { ...child.layout, x: columnX, y: Math.round(y) }
          moved = true
        }
        // Só quem está na coluna ocupa lugar nela: um helper arrastado pra fora
        // não deixa um vão onde ele estava.
        y += heightOf(child) + ROW_GAP
      }
      walk(child)
    }
  }

  for (const agent of all) {
    if (!agent.parentId) walk(agent)
  }
  return moved
}

/**
 * Onde um agente novo entra.
 *
 * Um filho entra no fim da coluna do pai; `relayout` logo arruma a pilha
 * inteira, mas nascer já perto do lugar evita a janela aparecer num ponto e
 * saltar pro outro. Uma raiz nova entra à direita de tudo que existe — de tudo
 * mesmo, não só das outras raízes: a subárvore da raiz anterior ocupa as
 * colunas da direita, e ignorá-la abriria o run novo por cima do antigo.
 */
function placeAgent(parentId: string | null): { x: number; y: number } {
  const all = [...agents.values()].map((l) => l.agent)
  const parent = parentId ? all.find((a) => a.id === parentId) : undefined

  if (parent) {
    const x = Math.round(parent.layout.x + parent.layout.w + COL_GAP)
    const siblings = childrenOf(all, parent.id).filter((a) => !a.layout.pinned)
    const y = siblings.reduce((acc, a) => acc + heightOf(a) + ROW_GAP, parent.layout.y)
    return { x, y: Math.round(y) }
  }

  if (!all.length) return { x: 0, y: 0 }
  const right = all.reduce((m, a) => Math.max(m, a.layout.x + a.layout.w), -Infinity)
  const top = all.reduce((m, a) => Math.min(m, a.layout.y), Infinity)
  return { x: Math.round(right + RUN_GAP), y: Math.round(top) }
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
 *
 * Mover é o gesto que fixa: um patch com x ou y veio de um arrasto, e uma
 * janela arrastada sai do arranjo automático pra ficar onde foi deixada.
 * Recolher, redimensionar e trazer pra frente não fixam nada — nenhum dos três
 * é uma afirmação sobre onde a janela deve estar.
 */
export function setLayout(id: string, patch: Partial<AgentLayout>): Agent | null {
  const live = agents.get(id)
  if (!live) return null
  const before = live.agent.layout
  const moved = Number.isFinite(patch.x) || Number.isFinite(patch.y)
  const next: AgentLayout = {
    x: Number.isFinite(patch.x) ? (patch.x as number) : before.x,
    y: Number.isFinite(patch.y) ? (patch.y as number) : before.y,
    w: Number.isFinite(patch.w) ? Math.max(360, patch.w as number) : before.w,
    h: Number.isFinite(patch.h) ? Math.max(180, patch.h as number) : before.h,
    collapsed: typeof patch.collapsed === 'boolean' ? patch.collapsed : before.collapsed,
    // `z: -1` é o pedido de "traz pra frente" sem o front saber o topo atual.
    z: patch.z === -1 ? topZ() + 1 : Number.isFinite(patch.z) ? (patch.z as number) : before.z,
    // `pinned: false` explícito é o botão de realinhar: devolve a janela à coluna.
    pinned: typeof patch.pinned === 'boolean' ? patch.pinned : moved || before.pinned,
  }
  const same =
    next.x === before.x &&
    next.y === before.y &&
    next.w === before.w &&
    next.h === before.h &&
    next.collapsed === before.collapsed &&
    next.z === before.z &&
    next.pinned === before.pinned
  if (same) return live.agent
  live.agent.layout = next
  // Recolher muda a altura, e a altura é o que empilha a coluna; desafixar
  // devolve a janela à pilha. Os dois pedem o arranjo de volta.
  relayout()
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
      modelReason: agent.modelReason,
      runId: agent.runId,
      runType: agent.runType,
      role: agent.role,
      note: agent.note,
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
  // Ficha gravada antes de o run existir não tem `runId`. Um helper herda o do
  // pai, então a herança só se resolve com todo mundo já na memória — por isso
  // é uma segunda passada, e não parte do `toAgent`.
  for (const live of agents.values()) {
    if (live.agent.runId) continue
    live.agent.runId = inheritedRunId(live.agent)
  }
  return state.agents.length
}

/** O run do ancestral mais próximo que tiver um; senão, um run só pra ele. */
function inheritedRunId(agent: Agent): string {
  const seen = new Set<string>([agent.id])
  let current = agent.parentId ? agents.get(agent.parentId)?.agent : undefined
  while (current && !seen.has(current.id)) {
    if (current.runId) return current.runId
    seen.add(current.id)
    current = current.parentId ? agents.get(current.parentId)?.agent : undefined
  }
  return newRunId(new Date(agent.createdAt))
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
    modelReason: p.modelReason ?? null,
    // Vazio aqui é resolvido na segunda passada do `restoreAgents`.
    runId: p.runId ?? '',
    // Ficha gravada antes dos tipos de run é freeform: é o tipo que não
    // restringe nada, e promover uma sessão antiga a reviewer na retomada
    // mudaria a política dela sem ninguém ter pedido.
    runType: isRunTypeId(p.runType) ? p.runType : DEFAULT_RUN_TYPE,
    role: p.role ?? null,
    // O `report` é do agente, não da sessão: ele sobrevive ao reinício, senão
    // um card recolhido perderia o resumo só porque o daemon caiu.
    note: p.note ?? null,
    waitingTool: null,
    // Estado gravado antes da unidade 3 não tem lugar no canvas: em vez de
    // empilhar todo mundo na origem, a ficha velha entra numa fileira.
    layout: p.layout ?? {
      x: index * (WIN_W + COL_GAP),
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
  /**
   * O modelo escolhido na mão. **`undefined` é "auto"**, e é por isso que ele
   * não é a mesma coisa que `null`: `null` é a escolha explícita de "padrão da
   * conta" (não passa `--model`), e `undefined` é "ninguém escolheu" — aí quem
   * decide é o tipo de run, pelo papel, com a tabela de roteamento no fim.
   */
  model?: AgentModel
  /** por que esse modelo, em uma linha */
  modelReason?: string | null
  /** o papel do helper, dado por quem o abriu */
  role?: string | null
  /** o run a que ele pertence; sem isso herda do pai, ou abre um novo */
  runId?: string
  /** o tipo do run; sem isso herda do pai, ou é o default */
  runType?: RunTypeId
  /** o que este run é pra fazer, em uma linha; vai pro brief do lead */
  subject?: string | null
  /**
   * Esta sessão é a retomada de outra.
   *
   * Um lead retomado NÃO recebe o brief de novo: ele já está no transcript que
   * o `--resume` trouxe de volta, e digitá-lo outra vez mandaria o agente
   * recomeçar o run do zero em cima do trabalho que ele acabou de recuperar.
   */
  resuming?: boolean
  args?: string[]
  /** política de permissão já pronta; sem isso, a do tipo de run */
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

  // A tela de confiança aparece antes de qualquer hook: se a pasta nunca foi
  // aceita, o card já nasce dizendo isso em vez de mentir `starting`.
  const trusted = isTrusted(cwd)

  // Um pai que não existe mais não vira seta pendurada no vazio.
  const parentId = opts.parentId && agents.has(opts.parentId) ? opts.parentId : null
  // O run vem de quem pediu, ou do pai, ou nasce aqui: um agente raiz é o
  // começo de um run, e um helper pertence ao run de quem o abriu.
  const parent = parentId ? agents.get(parentId)?.agent : undefined
  const runId = opts.runId || parent?.runId || newRunId()
  // O tipo é do RUN, não do agente: um helper não escolhe a política em que
  // nasce — ele herda a de quem o abriu. Só o agente raiz define o tipo.
  const type = opts.runType ?? parent?.runType ?? DEFAULT_RUN_TYPE
  const role = opts.role?.trim() || null

  // "auto" (`undefined`) é o default: quem decide é o tipo de run, pelo papel,
  // com a tabela de roteamento no fim. Uma escolha explícita — inclusive o
  // "padrão da conta", que é `null` — vence sem passar por aqui.
  const auto = opts.model === undefined ? defaultModelForRole(role, type) : null
  const model = auto ? auto.model : (opts.model as AgentModel)
  const modelReason = opts.modelReason?.trim() || auto?.reason || null

  const spot = placeAgent(parentId)
  const layout: AgentLayout = {
    x: opts.layout?.x ?? spot.x,
    y: opts.layout?.y ?? spot.y,
    w: opts.layout?.w ?? WIN_W,
    h: opts.layout?.h ?? WIN_H,
    collapsed: opts.layout?.collapsed ?? false,
    z: opts.layout?.z ?? topZ() + 1,
    pinned: opts.layout?.pinned ?? false,
  }

  const agent: Agent = {
    id,
    // O agente raiz de um run é o lead, e é assim que ele se chama. Um id
    // aleatório no lugar do nome obriga a adivinhar quem coordena o run
    // olhando as setas — e o nome é a primeira coisa que se lê numa janela.
    name: opts.name?.trim() || (parentId ? `helper-${id.slice(0, 4)}` : 'lead'),
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
    modelReason,
    runId,
    runType: type,
    role,
    note: null,
    waitingTool: null,
    layout,
    parentId,
    tint: typeof opts.tint === 'number' ? opts.tint : nextTint(),
  }

  const { term, serializer } = makeScreen(cols, rows)
  const live: Live = { agent, pty: null, subscribers: new Set(), term, serializer, stopping: false }

  // A política é montada AQUI, e não no tipo de run sozinho, porque ela
  // depende de coisas que só existem agora: o diretório deste run (pro agente
  // ler o próprio brief sem prompt) e se este agente é o lead (que é quem pode
  // abrir helpers). Um `permissions` explícito vence — é o cano que o teste
  // usa pra provocar uma política à mão.
  const context = { runId, isLead: !parentId, role, subject: opts.subject ?? null, cwd }
  const permissions = opts.permissions ?? runType(type).policy(context)

  // Os hooks sobem com a sessão: sem o --settings o agente é um terminal cego.
  const settingsFile = writeAgentSettings(id, permissions ? { permissions } : {})
  // E o MCP sobe junto: é por ele que um lead abre helpers e que um helper
  // conclui. O header do arquivo é a identidade do agente nas tool calls.
  const mcpFile = writeAgentMcpConfig(id)
  const args = [
    ...launch.prefix,
    '--settings',
    settingsFile,
    '--mcp-config',
    mcpFile,
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
    // `done` resiste: é conclusão registrada pelo tool do MCP, e rebaixá-la
    // apagaria o que o agente fez só porque o processo saiu depois.
    if (agent.status !== 'done') {
      agent.status = live.stopping || exitCode === 0 ? 'stopped' : 'failed'
    }
    agent.lastSignalAt = Date.now()
    // Uma sessão morta não vai digitar nada: o que estava na fila dela não tem
    // mais pra onde ir.
    clearOutbox(id)
    persist()
  })

  // O brief do LEAD. O do helper é escrito pelo `spawn_helper`, porque lá o
  // texto vem do lead; aqui ele vem do tipo de run, que é o que um agente
  // aberto pela gaveta tem no lugar de alguém que o instruiu.
  //
  // Vai pela mesma fila do resto: a TUI ainda não subiu quando o pty nasce, e
  // texto digitado antes dela se perde. Sai quando a sessão chegar a `idle`.
  if (!parentId && !opts.resuming) {
    const brief = leadBrief(type, context)
    if (brief) {
      try {
        const file = writeLeadBrief(runId, agent, brief)
        sendToAgent(id, 'brief', `Leia seu brief em ${file} e siga.`, Date.now() + config.briefGraceMs)
      } catch (err) {
        // Um brief que não se escreve não pode impedir o agente de existir: a
        // sessão é utilizável sem ele, só sem a orientação do tipo de run.
        console.error('falhou escrever o brief do lead:', err instanceof Error ? err.message : err)
      }
    }
  }

  // A coluna de helpers é uma pilha, e um agente novo entrou nela.
  relayout()
  persist()
  console.log(
    `+ agente ${agent.name} (${id.slice(0, 8)}) ${cols}x${rows} modelo=${model ?? 'conta'} cwd=${cwd}` +
      ` run=${runId} tipo=${type}` +
      (agent.role ? ` papel=${agent.role}` : '') +
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
    modelReason: old.modelReason,
    role: old.role,
    // A sessão reabre no MESMO run: o resultado e o log dela continuam no
    // diretório onde o resto do run está, e a política é a mesma — um reviewer
    // que voltasse freeform depois de um reinício seria a fronteira se
    // dissolvendo justamente no caminho de recuperação.
    runId: old.runId,
    runType: old.runType,
    resuming: true,
    args: ['--resume', old.sessionId],
    // A janela não pode pular de lugar só porque a sessão reabriu: o canvas é
    // memória espacial, e um card que se move sozinho apaga o que você lembrava.
    layout: old.layout,
    parentId: old.parentId,
    tint: old.tint,
  })
  // A ficha nova herda a identidade da antiga: pro front é o mesmo agente
  // voltando, não um segundo card — inclusive o último `report`, que é do
  // agente e não da sessão.
  resumed.sessionId = old.sessionId
  resumed.note = old.note
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
  const { changed, ended, deliver } = applyHookEvent(live.agent, event)

  // O log append-only do agente, no diretório do run. Não tem leitor ainda: é
  // a matéria-prima de um inspector/timeline, e o histórico que não se grava
  // agora não existe quando a tela pedir por ele. Escrever não espera disco —
  // o endpoint de hooks já respondeu à sessão antes de chegar aqui.
  appendHookLog(live.agent.runId, live.agent, {
    ts: new Date().toISOString(),
    event: event.hook_event_name ?? 'desconhecido',
    ...(event.tool_name ? { tool: event.tool_name } : {}),
    ...(() => {
      // O "input" de um evento é o que ele traz de entrada, e cada evento traz
      // o seu: a ferramenta traz argumentos, o prompt traz texto, a notificação
      // traz mensagem, o fim de sessão traz razão.
      const input =
        summarize(event.tool_input) ??
        summarize(event.prompt) ??
        summarize(event.message) ??
        summarize(event.reason) ??
        summarize(event.source)
      return input ? { input } : {}
    })(),
    ...(() => {
      const result = summarize(event.tool_response)
      return result ? { result } : {}
    })(),
    ...(before !== live.agent.status ? { status: `${before} → ${live.agent.status}` } : {}),
  })

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
    clearOutbox(id)
  }
  if (changed || ended) persist()
  // Stop e `idle_prompt` são os pontos de entrega da fila. A tentativa confere
  // sozinha se a sessão está mesmo livre, então chamar aqui não força nada.
  if (deliver && !ended) tryDeliver(id)
  return true
}

// ---------- falar com um agente ----------
//
// A única forma de dizer alguma coisa a uma sessão já aberta é o teclado dela,
// e é por isso que a entrega tem regra em vez de ser uma escrita. O que a regra
// impede: digitar por cima de um prompt de permissão (o texto responderia o
// prompt), digitar junto com o Enzo (os caracteres se misturam) e digitar numa
// sessão ocupada (o texto entra no meio de um turno).

/** Retentativas agendadas, uma por agente: sem isto elas se empilhariam. */
const retries = new Map<string, NodeJS.Timeout>()

function scheduleRetry(id: string, delay: number): void {
  if (retries.has(id)) return
  const timer = setTimeout(() => {
    retries.delete(id)
    tryDeliver(id)
  }, delay)
  timer.unref?.()
  retries.set(id, timer)
}

function clearOutbox(id: string): void {
  const timer = retries.get(id)
  if (timer) {
    clearTimeout(timer)
    retries.delete(id)
  }
  outboxClear(id)
}

/**
 * Tenta entregar UMA mensagem da fila do agente.
 *
 * Uma só, de propósito: a mensagem entregue vira um prompt, o agente sai de
 * `idle` e volta a trabalhar. Entregar duas emendaria as duas num texto só. A
 * segunda sai no próximo ponto de entrega, que é o Stop desse turno.
 */
export function tryDeliver(id: string): boolean {
  const live = agents.get(id)
  if (!live?.pty) return false
  const agent = live.agent
  const head = outboxPeek(id)
  if (!head) return false

  // Nada é digitado por cima de um prompt aberto — nem de permissão, nem da
  // tela de confiança. Quando ele for resolvido, o hook seguinte chama aqui.
  if (agent.status === 'needs_you' || agent.status === 'awaiting_trust') return false
  // Só numa sessão parada: `running` tem turno em andamento.
  if (agent.status !== 'idle') return false
  // E só se o Enzo não estiver escrevendo neste exato agente.
  if (typingRecently(id, config.quietMs)) {
    scheduleRetry(id, config.quietMs)
    return false
  }
  // A mensagem pode ter hora pra sair — é o caso do brief, que nasce junto com
  // a sessão e espera a TUI acabar de subir.
  if (head.notBefore && Date.now() < head.notBefore) {
    scheduleRetry(id, head.notBefore - Date.now())
    return false
  }

  const message = outboxShift(id)
  if (!message) return false

  const pty = live.pty
  try {
    pty.write(message.text)
    // O Enter vai num segundo tempo: a TUI precisa ter processado o texto antes
    // de receber o envio, senão o Enter chega num campo que ainda está vazio.
    const timer = setTimeout(() => {
      try {
        pty.write('\r')
      } catch {
        /* a sessão morreu entre o texto e o Enter */
      }
    }, config.enterDelayMs)
    timer.unref?.()
  } catch (err) {
    // Não deu pra escrever: a mensagem volta pra fila em vez de sumir.
    outboxUnshift(id, message)
    console.error('falhou entregar ao agente:', err instanceof Error ? err.message : err)
    return false
  }
  console.log(`  → ${agent.name} ${message.kind}: ${message.text.slice(0, 90)}`)
  return true
}

/**
 * Põe uma mensagem na fila do agente e tenta entregar na hora.
 *
 * "Na hora" só acontece se ele já estiver livre; senão fica na fila e sai no
 * próximo Stop ou `idle_prompt`. É o caminho tanto do brief inicial de um
 * helper quanto da notificação do lead.
 */
export function sendToAgent(
  id: string,
  kind: OutgoingKind,
  text: string,
  notBefore?: number,
): number {
  const live = agents.get(id)
  if (!live) return 0
  const size = outboxEnqueue(id, kind, text, notBefore)
  if (!tryDeliver(id) && notBefore) {
    // Ainda não é hora: a tentativa de agora não agendou nada porque a sessão
    // nem chegou a `idle`. Quando chegar, o hook chama de volta.
    scheduleRetry(id, Math.max(0, notBefore - Date.now()))
  }
  return size
}

/** Quantas mensagens ainda esperam a vez. */
export function pendingFor(id: string): number {
  return outboxPending(id)
}

// ---------- o que o agente diz de si ----------

/** O `report` do MCP: a nota do agente, que o card recolhido mostra. */
export function setAgentNote(id: string, status: string, summary: string): Agent | null {
  const live = agents.get(id)
  if (!live) return null
  live.agent.note = { status, summary, at: Date.now() }
  live.agent.lastSignalAt = Date.now()
  persist()
  return live.agent
}

/**
 * O `done` do MCP: a única origem do status `done`.
 *
 * Hook nenhum produz `done` — uma sessão que encerra sem ter chamado o tool
 * vira `stopped` ou `failed` pela tabela. `done` é conclusão declarada.
 */
export function markDone(id: string, summary: string): Agent | null {
  const live = agents.get(id)
  if (!live) return null
  live.agent.status = 'done'
  live.agent.waitingTool = null
  live.agent.note = { status: 'concluiu', summary, at: Date.now() }
  live.agent.lastSignalAt = Date.now()
  persist()
  return live.agent
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
  // Este teclado é do Enzo — a entrega do daemon não passa por aqui. Marcar a
  // batida é o que segura uma injeção no meio de uma frase que ele está
  // escrevendo: é o segundo caso de colisão do TDD, o que a fila não cobre.
  noteTyping(id)
  // Responder um prompt de permissão é a única saída de `needs_you` que
  // existe: a rejeição não gera hook nenhum.
  if (noteUserInput(live.agent, data)) {
    persist()
    // A permissão foi resolvida e o agente voltou a `idle`: o que estava
    // segurado por causa do prompt pode sair — depois do silêncio do teclado.
    scheduleRetry(id, config.quietMs)
  }
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
  // `done` não é rebaixado por encerramento: um helper que concluiu e foi
  // fechado continua tendo concluído.
  if (live.agent.status !== 'done') live.agent.status = 'stopped'
  live.agent.lastSignalAt = Date.now()
  // Sem pty não há pra onde entregar.
  clearOutbox(id)
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
  removeAgentMcpConfig(id)
  clearOutbox(id)
  agents.delete(id)
  // Quem ficou na coluna dele sobe pra ocupar o vão.
  relayout()
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
