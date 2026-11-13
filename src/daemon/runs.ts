// O run: a que agrupamento um agente pertence, e onde o que ele produz fica.
//
// Um run nasce com um agente raiz — o lead — e todo helper herda o run de quem
// o abriu. É o menor conceito que esta unidade exige: o `done` precisa de uma
// pasta pra escrever o resultado, e o log de hooks precisa da mesma pasta.
// Gaveta, histórico e tipos de run são da unidade 5; aqui o run é o nome e o
// diretório, nada mais.
//
// Tudo que se escreve aqui é append-only ou arquivo novo. Nada neste módulo
// sobrescreve nada: um run é um registro do que aconteceu, e um registro que se
// reescreve não serve pra reconstruir uma timeline depois.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { paths } from './config.js'

/** `run-20261112-143002-a1b2`: ordena por nome e se lê sem ferramenta. */
export function newRunId(at = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  return `run-${stamp}-${randomBytes(2).toString('hex')}`
}

/**
 * Um pedaço de nome que pode virar caminho.
 *
 * O nome do helper é escolhido pelo lead — quer dizer, por um modelo — e vira
 * nome de arquivo no diretório do run. Sem esta passagem, um nome com barra ou
 * com `..` escreveria fora da pasta do run.
 */
export function slug(raw: string, fallback = 'agente'): string {
  const clean = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return clean || fallback
}

export function runDir(runId: string): string {
  return path.join(paths.runs(), slug(runId, 'run'))
}

/** Escreve um arquivo novo no diretório do run e devolve o caminho. */
export async function writeRunFile(
  runId: string,
  relative: string,
  content: string,
): Promise<string> {
  const file = path.join(runDir(runId), relative)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content, 'utf8')
  return file
}

/**
 * O brief do lead, escrito antes de o pty existir.
 *
 * É síncrono, ao contrário de tudo o mais aqui, porque `createAgent` é
 * síncrono: o caminho do arquivo precisa estar pronto pra entrar na primeira
 * mensagem da fila, e esperar uma promessa aqui abriria uma janela em que o
 * agente já está de pé sem ter o que ler.
 */
export function writeLeadBrief(
  runId: string,
  agent: { id: string; name: string },
  content: string,
): string {
  const file = path.join(
    runDir(runId),
    'briefs',
    `${slug(agent.name, 'lead')}-${agent.id.slice(0, 8)}.md`,
  )
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return file
}

/**
 * Um caminho que ainda não existe, a partir do que se queria.
 *
 * Dois helpers com o mesmo nome no mesmo run são comuns (o lead chama os dois
 * de "revisor"), e o segundo não pode apagar o resultado do primeiro.
 */
export async function freePath(dir: string, base: string, ext: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? `${base}${ext}` : `${base}-${i + 1}${ext}`
    const file = path.join(dir, name)
    try {
      await fsp.access(file)
    } catch {
      return file
    }
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`)
}

// ---------- o log de eventos de hook ----------
//
// Uma linha JSON por evento, por agente, em ordem de chegada. Não tem leitor
// ainda: é a matéria-prima de um inspector/timeline, e o custo de gravar agora
// é muito menor que o de não ter o histórico quando a tela existir.

export type HookLogEntry = {
  /** ISO, pra timeline não depender da ordem das linhas do arquivo */
  ts: string
  /** nome do evento (`PreToolUse`, `Stop`, …) */
  event: string
  /** a ferramenta, quando o evento é de ferramenta */
  tool?: string
  /** resumo do que entrou: input da ferramenta, prompt, mensagem ou razão */
  input?: string
  /** resumo do que saiu: resultado da ferramenta */
  result?: string
  /** a transição que este evento causou, quando causou alguma */
  status?: string
}

/** Teto de cada campo resumido. Um log que guarda tudo vira o transcript. */
const FIELD_LIMIT = 400

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > FIELD_LIMIT ? `${flat.slice(0, FIELD_LIMIT)}…` : flat
}

/** Resume qualquer valor numa linha. `undefined` quando não há o que dizer. */
export function summarize(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return clip(value) || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return clip(JSON.stringify(value)) || undefined
  } catch {
    // Referência circular ou coisa que não serializa: o tipo já diz alguma coisa.
    return `[${typeof value}]`
  }
}

function logFile(runId: string, agentName: string, agentId: string): string {
  return path.join(runDir(runId), 'hooks', `${slug(agentName)}-${agentId.slice(0, 8)}.jsonl`)
}

// Uma corrente de escrita por arquivo. `appendFile` concorrente no mesmo
// arquivo pode intercalar linhas, e uma linha partida ao meio não é JSON.
const chains = new Map<string, Promise<void>>()

/**
 * Acrescenta um evento ao log do agente. Não espera: nada no caminho de um
 * hook pode esperar disco — o endpoint já respondeu à sessão antes disto.
 */
export function appendHookLog(
  runId: string,
  agent: { id: string; name: string },
  entry: HookLogEntry,
): void {
  const file = logFile(runId, agent.name, agent.id)
  const line = `${JSON.stringify(entry)}\n`
  const previous = chains.get(file) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.appendFile(file, line, 'utf8')
    })
    .catch((err: unknown) => {
      console.error('falhou gravar o log de hooks:', err instanceof Error ? err.message : err)
    })
  chains.set(file, next)
}
