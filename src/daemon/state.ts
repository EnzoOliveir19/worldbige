// Estado em arquivo JSON, gravado a cada mudança.
//
// O que sobrevive a um reinício do daemon é a ficha do agente, não o processo:
// os ptys morrem junto com o daemon. Por isso tudo que é restaurado volta
// `stopped`, com o `sessionId` guardado — é ele que a unidade 2 usa pra reabrir
// a sessão com `claude --resume`.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, paths } from './config.js'
import type { AgentLayout, AgentNote, AgentStatus } from './agents.js'

export type PersistedAgent = {
  id: string
  name: string
  cwd: string
  status: AgentStatus
  createdAt: number
  lastSignalAt: number
  exitCode: number | null
  cols: number
  rows: number
  /** capturado do primeiro hook que chegar; é o que permite o `--resume` */
  sessionId: string | null
  /** modelo pedido no spawn; null = padrão da conta */
  model?: 'opus' | 'sonnet' | 'haiku' | 'fable' | null
  /** por que esse modelo, em uma linha — quem escreve é quem abriu o agente */
  modelReason?: string | null
  /**
   * A que run este agente pertence. É a pasta onde o resultado do `done` e o
   * log de eventos dele são escritos.
   */
  runId?: string
  /** o papel que o lead deu ao helper no `spawn_helper` */
  role?: string | null
  /** o último `report` do próprio agente; é o que o card recolhido mostra */
  note?: AgentNote | null
  /**
   * Onde a janela está no canvas. Mora aqui, e não no front, porque o front é
   * descartável por desenho: arrastar uma janela e recarregar a aba não pode
   * desfazer o arrasto.
   */
  layout?: AgentLayout
  /** quem abriu este agente — é a seta no canvas (e o `after` da unidade 4) */
  parentId?: string | null
  /** índice da tinta de identidade: o ponto na gaveta, a linha e o fio da janela */
  tint?: number
}

export type State = {
  version: 1
  agents: PersistedAgent[]
}

const EMPTY: State = { version: 1, agents: [] }

export function loadState(): State {
  const file = paths.state()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as State
    if (parsed?.version !== 1 || !Array.isArray(parsed.agents)) return { ...EMPTY }
    return parsed
  } catch {
    // Sem arquivo, ou arquivo corrompido: começa limpo em vez de não subir.
    return { ...EMPTY }
  }
}

let pending: State | null = null
let timer: NodeJS.Timeout | null = null
let writing: Promise<void> = Promise.resolve()

async function flush(): Promise<void> {
  const snapshot = pending
  pending = null
  timer = null
  if (!snapshot) return
  const file = paths.state()
  const tmp = `${file}.tmp`
  await fsp.mkdir(path.dirname(file), { recursive: true })
  // Grava e renomeia: um daemon morto no meio da escrita não deixa JSON pela metade.
  await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
  await fsp.rename(tmp, file)
}

/** Agenda a gravação. Rajadas de mudança viram uma escrita só. */
export function saveState(state: State): void {
  pending = state
  if (timer) return
  timer = setTimeout(() => {
    writing = writing.then(flush).catch((err: unknown) => {
      console.error('falhou gravar o estado:', err instanceof Error ? err.message : err)
    })
  }, 120)
  timer.unref?.()
}

/** Grava agora e espera — pro caminho de saída do processo. */
export async function flushState(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  await writing
  await flush().catch(() => {})
}

export function ensureDataDirs(): void {
  for (const dir of [config.dataDir, paths.runs(), paths.briefs(), paths.tmp()]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
