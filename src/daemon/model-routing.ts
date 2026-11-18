// A tabela de roteamento de modelo, lida de um arquivo markdown.
//
// A tabela é arquivo e não código porque a calibragem — que trabalho merece que
// modelo — se aprende usando. Editar `config/model-routing.md` vale pro próximo
// helper, sem recompilar e sem reiniciar o daemon.
//
// O mesmo arquivo serve a dois leitores, e é por isso que ele é markdown e não
// JSON: o daemon parseia a tabela de pipes, e o LEAD lê o arquivo inteiro —
// o brief dele manda ler isto antes de escolher o `model` de cada helper. Um
// JSON seria mais fácil de parsear e pior de ler; a prosa em volta da tabela é
// metade do conteúdo.
import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from './config.js'
import type { AgentModel } from './agents.js'

/** Onde a tabela vive. Override pra quem quiser a sua. */
export function routingTablePath(): string {
  const override = process.env.WORLDBIGE_MODEL_ROUTING?.trim()
  return override ? path.resolve(override) : path.join(repoRoot, 'config', 'model-routing.md')
}

const MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable'])

export type RoutingRule = {
  /** a palavra procurada no papel; `*` é a linha de fallback */
  role: string
  model: AgentModel
}

export type RoutingTable = {
  rules: RoutingRule[]
  /** o que vale quando nenhuma regra casa — a linha `*` */
  fallback: AgentModel
  /** de onde isto veio, pra mensagem de erro e pro brief */
  file: string
}

/**
 * A tabela é relida quando o arquivo muda.
 *
 * Reler a cada `spawn_helper` seria disco à toa; nunca reler obrigaria a
 * reiniciar o daemon pra calibrar, que é justamente o que tirar a tabela do
 * código deveria evitar. O mtime resolve os dois.
 */
let cached: { table: RoutingTable; mtimeMs: number; file: string } | null = null

/**
 * Lê as linhas de uma tabela de pipes.
 *
 * Só interessa a primeira coluna (o papel) e a segunda (o modelo). A linha de
 * cabeçalho e a de separação (`|---|---|`) caem fora sozinhas: o cabeçalho
 * porque "modelo" não é um modelo, a separação porque só tem traço.
 */
function parse(source: string, file: string): RoutingTable {
  const rules: RoutingRule[] = []
  let fallback: AgentModel = 'sonnet'

  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cells.length < 2) continue

    // `\*` é como o markdown escapa o asterisco numa célula — a tabela é lida
    // por gente também, e o escape faz parte de ela ficar legível renderizada.
    const role = (cells[0] as string).replace(/\\/g, '').trim().toLowerCase()
    const model = (cells[1] as string).trim().toLowerCase()
    if (!role || !MODELS.has(model)) continue

    if (role === '*') fallback = model as AgentModel
    else rules.push({ role, model: model as AgentModel })
  }

  return { rules, fallback, file }
}

/** Uma tabela mínima, pra quando o arquivo some ou não se lê. */
function builtin(file: string): RoutingTable {
  return {
    rules: [
      { role: 'review', model: 'opus' },
      { role: 'arquitetura', model: 'opus' },
      { role: 'skeptic', model: 'fable' },
      { role: 'bug', model: 'fable' },
      { role: 'busca', model: 'sonnet' },
    ],
    fallback: 'sonnet',
    file,
  }
}

export function routingTable(): RoutingTable {
  const file = routingTablePath()
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    // Sem arquivo, a tabela embutida: um helper tem que abrir de qualquer jeito.
    // Um default ruim é melhor que um run que não começa.
    if (!cached || cached.file !== file) {
      console.warn(`tabela de roteamento não encontrada em ${file} — usando a embutida`)
      cached = { table: builtin(file), mtimeMs: 0, file }
    }
    return cached.table
  }

  if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached.table

  try {
    const table = parse(fs.readFileSync(file, 'utf8'), file)
    // Um arquivo editado até ficar sem nenhuma linha válida não deve apagar o
    // roteamento em silêncio: sem regra nenhuma, a embutida volta.
    const useful = table.rules.length ? table : { ...builtin(file), fallback: table.fallback }
    cached = { table: useful, mtimeMs, file }
    return useful
  } catch (err) {
    console.error('falhou ler a tabela de roteamento:', err instanceof Error ? err.message : err)
    cached = { table: builtin(file), mtimeMs, file }
    return cached.table
  }
}

/**
 * O modelo que a tabela indica pra um papel.
 *
 * O casamento é por palavra contida: o lead escreve o papel em prosa ("review
 * do PR 412", "busca nos quatro repos") e não um enum, então exigir igualdade
 * faria a tabela quase nunca casar. Vale a primeira regra cuja palavra apareça
 * no papel — a ordem do arquivo é a ordem da decisão, e quem edita a tabela
 * controla a precedência pondo a linha mais específica antes da mais geral.
 */
export function modelFromTable(role: string | null | undefined): {
  model: AgentModel
  matched: string
} {
  const table = routingTable()
  const needle = (role ?? '').toLowerCase()
  if (needle) {
    for (const rule of table.rules) {
      if (needle.includes(rule.role)) return { model: rule.model, matched: rule.role }
    }
  }
  return { model: table.fallback, matched: '*' }
}
