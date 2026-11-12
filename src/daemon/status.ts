// A máquina de status, da tabela do TDD — literal, sem status inventado.
//
// Uma correção de campo em relação ao TDD: ele guarda o `session_id` no
// SessionStart, mas SessionStart NÃO dispara via `--settings` (medido duas
// vezes: dos oito eventos, é o único que nunca chegou). O `session_id` vem em
// TODOS os eventos, então ele é capturado do primeiro que chegar. O que se
// perde é o `source` (startup/resume/clear), que a tabela não usa pra decidir
// nada.
//
// `done` não vem de hook nenhum: só do tool `done` do MCP (unidade 4).
import type { Agent, AgentStatus } from './agents.js'

export type HookEvent = {
  hook_event_name?: string
  session_id?: string
  transcript_path?: string
  reason?: string
  tool_name?: string
  message?: string
  notification_type?: string
  source?: string
  model?: string
  permission_mode?: string
}

/**
 * Classifica uma Notification. O payload traz um `notification_type`, que é o
 * sinal estruturado — o texto de `message` só serve de reserva, pra não ficar
 * cego se o campo faltar. O que não reconhecemos não mexe no status: melhor
 * não saber do que inventar um estado.
 */
function classifyNotification(event: HookEvent): 'permission' | 'idle' | null {
  const t = event.notification_type?.toLowerCase() ?? ''
  if (t.includes('permission')) return 'permission'
  if (t.includes('idle')) return 'idle'

  const m = event.message?.toLowerCase() ?? ''
  if (!m) return null
  if (m.includes('permission') || m.includes('approve')) return 'permission'
  if (m.includes('waiting for your input') || m.includes('idle')) return 'idle'
  return null
}

/** SessionEnd decide por `reason`, exatamente como a tabela do TDD manda. */
function statusForSessionEnd(reason: string | undefined): AgentStatus {
  switch (reason) {
    case 'clear':
    case 'resume':
    case 'prompt_input_exit':
      return 'stopped'
    case 'logout':
    case 'other':
      return 'failed'
    default:
      // Razão desconhecida: `stopped` é o estado honesto — a sessão acabou, e
      // `failed` afirmaria um fracasso que ninguém observou.
      return 'stopped'
  }
}

export type HookOutcome = {
  /** mudou alguma coisa que valha persistir/avisar o front? */
  changed: boolean
  /** o pty deve ser encerrado? (SessionEnd) */
  ended: boolean
}

export function applyHookEvent(agent: Agent, event: HookEvent): HookOutcome {
  const before = agent.status
  const beforeTool = agent.waitingTool
  const beforeSession = agent.sessionId

  // Qualquer evento é sinal de vida — é o que impede o watchdog de marcar
  // `stale` um comando que demora minutos.
  agent.lastSignalAt = Date.now()

  // O session_id vem em todo evento; o primeiro que chegar já serve pro resume.
  if (event.session_id && agent.sessionId !== event.session_id) {
    agent.sessionId = event.session_id
  }

  let ended = false

  switch (event.hook_event_name) {
    case 'SessionStart':
      // Chega por hook `command` (só por ele). `source` diz como a sessão
      // nasceu: `resume` é uma sessão reaberta, que está pronta e esperando —
      // `idle`, não `starting`, que faria o card mentir até o primeiro prompt.
      agent.status = 'idle'
      agent.waitingTool = null
      break

    case 'UserPromptSubmit':
      agent.status = 'running'
      agent.waitingTool = null
      break

    case 'PreToolUse':
    case 'PostToolUse':
      // Só renova o timestamp (já renovado acima). Um comando longo continua
      // `running` em vez de virar `stale`.
      if (agent.status === 'needs_you') {
        // A permissão foi resolvida e a ferramenta rodou: voltou a trabalhar.
        agent.status = 'running'
        agent.waitingTool = null
      }
      break

    case 'PermissionRequest':
      agent.status = 'needs_you'
      agent.waitingTool = event.tool_name ?? null
      break

    case 'Notification': {
      const kind = classifyNotification(event)
      // Redundância idempotente do PermissionRequest: qualquer um dos dois
      // acende o card, e acender duas vezes não muda nada.
      if (kind === 'permission') {
        agent.status = 'needs_you'
        if (event.tool_name) agent.waitingTool = event.tool_name
      } else if (kind === 'idle' && agent.status !== 'needs_you') {
        agent.status = 'idle'
      }
      break
    }

    case 'Stop':
      // Ponto de entrega da fila de notificação (unidade 4).
      if (agent.status !== 'needs_you') {
        agent.status = 'idle'
        agent.waitingTool = null
      }
      break

    case 'SessionEnd':
      agent.status = statusForSessionEnd(event.reason)
      agent.waitingTool = null
      agent.live = false
      ended = true
      break

    default:
      break
  }

  return {
    changed:
      agent.status !== before ||
      agent.waitingTool !== beforeTool ||
      agent.sessionId !== beforeSession,
    ended,
  }
}

/**
 * O usuário respondeu um prompt de permissão.
 *
 * Rejeitar um pedido NÃO dispara hook nenhum — medido com PermissionDenied,
 * StopFailure e PostToolUseFailure todos registrados: depois do Esc não chega
 * absolutamente nada, embora o turno acabe na tela. Sem um sinal de saída, o
 * card ficaria `needs_you` para sempre.
 *
 * O sinal real aqui não está na saída do pty (ler a tela seria a heurística de
 * texto que o desenho recusa), está na ENTRADA: o daemon vê o teclado que
 * passa pelo WebSocket, e `needs_you` quer dizer "esperando você" — no instante
 * em que você responde, não está mais.
 *
 * Vai pra `idle`, não pra `running`, porque é o estado certo quando a resposta
 * é "não": o turno acaba ali. Se a resposta foi "sim", o PreToolUse seguinte
 * chega em seguida e corrige pra `running` sozinho.
 *
 * Só teclas que RESOLVEM o prompt contam. Navegar no menu com as setas não
 * apaga o destaque enquanto a pessoa ainda está decidindo.
 */
export function noteUserInput(agent: Agent, data: string): boolean {
  if (agent.status !== 'needs_you') return false
  const resolves =
    data === '\x1b' || // Esc, sozinho — seta é '\x1b[A' e não conta
    data === '\r' ||
    data === '\n' ||
    /^[1-9]$/.test(data)
  if (!resolves) return false
  agent.status = 'idle'
  agent.waitingTool = null
  agent.lastSignalAt = Date.now()
  return true
}

/**
 * `stale` é silêncio além do limite — e só isso. Com Pre/PostToolUse renovando
 * a cada tool call, `stale` passa a significar sinal perdido de verdade (daemon
 * fora do ar durante o evento, sessão travada), não comando demorado.
 */
export function markIfStale(agent: Agent, limitMs: number, now = Date.now()): boolean {
  if (!agent.live) return false
  // Só quem deveria estar trabalhando fica `stale`. Um agente `idle` está
  // calado por motivo legítimo: ninguém pediu nada.
  if (agent.status !== 'running' && agent.status !== 'starting') return false
  if (now - agent.lastSignalAt < limitMs) return false
  agent.status = 'stale'
  return true
}
