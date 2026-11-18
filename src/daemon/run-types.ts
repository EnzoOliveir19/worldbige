// Os tipos de run: o que muda entre "abrir um Claude" e "abrir um reviewer".
//
// Um tipo de run carrega três coisas, e nenhuma delas é código novo por tipo:
//
//   1. a POLÍTICA de permissão que entra no `--settings` da sessão;
//   2. o MODELO default de cada papel (lead e helper);
//   3. o BRIEF do lead, um markdown que o daemon escreve no diretório do run e
//      manda a sessão ler.
//
// É por isso que o TDD diz que os tipos adiados (TDD/PRD, ticket do Linear,
// triagem) são "briefs novos, sem código novo": acrescentar um tipo é
// acrescentar uma entrada nesta tabela e um markdown em `briefs/`.
//
// Sobre a política, uma honestidade que o TDD já carrega: regra sobre texto de
// comando NÃO é fronteira de segurança. `git -C . push` passa pelo deny de
// `git push`. As listas daqui são redução de superfície e de fricção; a
// fronteira real é o modo manual forçado somado ao humano no loop — o que não
// casa com `allow` pergunta, o prompt acende `precisa de você` no card, e nada
// executa sozinho.
import fs from 'node:fs'
import path from 'node:path'
import { config, repoRoot } from './config.js'
import { modelFromTable, routingTablePath } from './model-routing.js'
import { runDir } from './runs.js'
import { toolName } from './mcp-config.js'
import type { AgentModel } from './agents.js'

export type RunTypeId = 'freeform' | 'review-pr'

export const DEFAULT_RUN_TYPE: RunTypeId = 'freeform'

/** O que o daemon sabe na hora de montar a política e o brief de um agente. */
export type RunContext = {
  runId: string
  /** este agente é o agente raiz do run? */
  isLead: boolean
  /** o papel do helper, quando é um helper */
  role: string | null
  /** o que o Enzo escreveu no campo de assunto ao abrir o run */
  subject: string | null
  cwd: string
}

export type RunType = {
  id: RunTypeId
  label: string
  /** uma linha pro dropdown do front */
  hint: string
  /**
   * O modelo de cada papel quando ninguém escolhe.
   *
   * `undefined` quer dizer "não fixa" — e aí quem decide é a tabela de
   * roteamento, pelo papel. `null` quer dizer "padrão da conta": o daemon não
   * passa `--model` e a configuração do Enzo decide.
   */
  models: { lead: AgentModel | undefined; helper: AgentModel | undefined }
  /** as listas que entram no `--settings`; `undefined` = sobe sem política */
  policy: (ctx: RunContext) => Record<string, unknown> | undefined
  /** o arquivo em `briefs/` (ou `private/briefs/`) com o brief do lead */
  brief: string
}

// ---------- caminhos em regra de permissão ----------

/**
 * Um diretório vira o especificador de caminho que as regras entendem.
 *
 * Duas pegadinhas, as duas medidas na prática e as duas capazes de fazer a
 * regra existir sem casar com nada:
 *
 *   - UMA barra no começo ancora o caminho no diretório do arquivo de settings
 *     (que aqui é `data/tmp/`), não na raiz do sistema. Caminho absoluto é com
 *     DUAS barras.
 *   - no Windows o caminho é normalizado pra forma POSIX antes de casar:
 *     `C:\dev\x` vira `/c/dev/x`. A letra do drive entra minúscula e sem os
 *     dois pontos.
 */
export function readRule(dir: string): string {
  const posix = path.resolve(dir).replace(/\\/g, '/')
  const drive = /^([a-zA-Z]):\//.exec(posix)
  const absolute = drive ? `/${(drive[1] as string).toLowerCase()}${posix.slice(2)}` : posix
  return `Read(/${absolute}/**)`
}

/**
 * O agente lê o próprio brief sem pedir permissão.
 *
 * Esta é a regra que todo tipo de run carrega, inclusive o freeform. O brief
 * mora no diretório do run, que fica fora do `cwd` do agente — então, sem ela,
 * a PRIMEIRA coisa que todo helper faz, toda vez, é abrir um prompt de
 * permissão e acender `precisa de você` no card. Foi o que o teste de fumaça da
 * unidade 4 encontrou, e é o motivo de freeform ter uma política de uma linha
 * em vez de nenhuma.
 */
function ownRunDirAllow(runId: string): string[] {
  return [readRule(runDir(runId))]
}

// ---------- as listas do reviewer ----------

/**
 * Bash que só lê. O reviewer vive destes comandos.
 *
 * Vale notar o que esta lista faz e o que não faz: ela tira a fricção de um
 * review (sem ela, cada `git diff` é um prompt no modo manual) e reduz a
 * superfície. Ela não impede nada — quem quisesse escapar escreveria o comando
 * de outro jeito. Quem impede é o modo manual: o que não está aqui pergunta.
 */
const BASH_READ = [
  'git log',
  'git diff',
  'git show',
  'git status',
  'git blame',
  'git branch',
  'git remote -v',
  'git rev-parse',
  'gh pr view',
  'gh pr diff',
  'gh pr list',
  'gh pr checks',
  'gh issue view',
  'gh issue list',
  'gh repo view',
]

/**
 * O que nunca sai daqui pro mundo.
 *
 * "Postar qualquer coisa no GitHub" está no Fora de escopo do spec, e o review
 * fica local: a saída do reviewer é o `done`, que o daemon salva como markdown.
 */
const BASH_WRITE = [
  'git push',
  'git commit',
  'git merge',
  'git rebase',
  'git reset',
  'git checkout',
  'git switch',
  'git restore',
  'git clean',
  'git tag',
  'gh pr comment',
  'gh pr review',
  'gh pr create',
  'gh pr edit',
  'gh pr merge',
  'gh pr close',
  'gh pr reopen',
  'gh pr ready',
  'gh issue comment',
  'gh issue create',
  'gh issue edit',
  'gh issue close',
  'gh release create',
  'gh api',
]

/**
 * Os conectores do claude.ai, cujos tools se chamam
 * `mcp__claude_ai_<servidor>__<tool>`.
 *
 * Leitura fica liberada porque um review precisa do ticket: sem ler o Linear
 * não dá pra dizer se o PR faz o que foi pedido. Escrita vai pra `ask` e não
 * pra `deny` pelo mesmo motivo — comentar no ticket é uma coisa razoável de se
 * querer, desde que eu veja o prompt antes.
 *
 * Glob parcial depois do prefixo literal `mcp__<servidor>__` funciona nas três
 * listas: medido nesta unidade, com o próprio prompt de permissão citando a
 * regra `mcp__claude_ai_Linear__save_*` que o fez aparecer.
 */
const CONNECTOR_READ = [
  'mcp__claude_ai_Linear__get_*',
  'mcp__claude_ai_Linear__list_*',
  'mcp__claude_ai_Linear__search_*',
  'mcp__claude_ai_Slack__slack_read_*',
  'mcp__claude_ai_Slack__slack_search_*',
  'mcp__claude_ai_Slack__slack_list_*',
]

const CONNECTOR_WRITE = [
  'mcp__claude_ai_Linear__save_*',
  'mcp__claude_ai_Linear__create_*',
  'mcp__claude_ai_Linear__delete_*',
  'mcp__claude_ai_Linear__update_*',
  'mcp__claude_ai_Linear__submit_*',
  'mcp__claude_ai_Linear__merge_*',
  'mcp__claude_ai_Slack__slack_send_*',
  'mcp__claude_ai_Slack__slack_add_*',
  'mcp__claude_ai_Slack__slack_create_*',
  'mcp__claude_ai_Slack__slack_update_*',
  'mcp__claude_ai_Slack__slack_schedule_*',
]

function reviewPolicy(ctx: RunContext): Record<string, unknown> {
  return {
    // Tem precedência sobre a configuração da conta, e é o que torna a política
    // confiável numa conta que roda em auto mode: sem isto, o classificador do
    // auto decidiria sozinho o que o reviewer pode fazer. Medido: a sessão sobe
    // dizendo "manual mode on" no rodapé.
    defaultMode: 'default',
    deny: [
      // Nome de ferramenta sem parênteses REMOVE a ferramenta do contexto: o
      // reviewer não vê Edit nem Write, em vez de vê-las e tomar um "negado"
      // depois de já ter escrito a edição. Medido nesta unidade.
      'Edit',
      'Write',
      'NotebookEdit',
      ...BASH_WRITE.map((cmd) => `Bash(${cmd}:*)`),
      // Helper não abre helper: a árvore de um review é lead → revisores, e um
      // revisor que delega vira um run que ninguém acompanha. O lead continua
      // podendo, porque é o trabalho dele.
      ...(ctx.isLead ? [] : [toolName('spawn_helper')]),
    ],
    ask: CONNECTOR_WRITE,
    allow: [
      ...ownRunDirAllow(ctx.runId),
      ...BASH_READ.map((cmd) => `Bash(${cmd}:*)`),
      ...CONNECTOR_READ,
      // O canal de volta do agente, sempre liberado: um reviewer que precisa
      // pedir permissão pra dizer que terminou não terminaria nunca.
      toolName('report'),
      toolName('done'),
      ...(ctx.isLead
        ? [toolName('spawn_helper'), toolName('list_helpers'), toolName('close_helper'), toolName('get_run')]
        : []),
    ],
  }
}

/**
 * Freeform sobe sem política — com uma exceção de uma linha.
 *
 * O TDD diz "conectores presentes, modo padrão da conta", e é o que continua
 * valendo: nada de `defaultMode`, nada de deny, nada de ask. A única regra é o
 * allow do diretório do run, que não restringe nada — só evita que todo agente
 * peça permissão pra ler o próprio brief.
 */
function freeformPolicy(ctx: RunContext): Record<string, unknown> {
  return { allow: ownRunDirAllow(ctx.runId) }
}

export const RUN_TYPES: Record<RunTypeId, RunType> = {
  freeform: {
    id: 'freeform',
    label: 'freeform',
    hint: 'um lead sem política, do jeito que a conta já roda',
    // Freeform não opina sobre o lead: quem abre um run livre quer a sessão
    // que teria aberto no terminal. Os helpers seguem a tabela pelo papel.
    models: { lead: null, helper: undefined },
    policy: freeformPolicy,
    brief: 'freeform.md',
  },
  'review-pr': {
    id: 'review-pr',
    label: 'review de PR',
    hint: 'reviewer read-only: sem editar, sem postar, resultado em markdown',
    // Review de PR é leitura crítica de código alheio, que é a linha `review`
    // da tabela. O lead fica fixo em opus porque é ele quem assina o veredito;
    // os helpers seguem a tabela, então uma busca nasce sonnet e um skeptic
    // nasce fable sem ninguém pedir.
    models: { lead: 'opus', helper: undefined },
    policy: reviewPolicy,
    brief: 'review-pr.md',
  },
}

export function runType(id: string | null | undefined): RunType {
  return RUN_TYPES[(id ?? '') as RunTypeId] ?? RUN_TYPES[DEFAULT_RUN_TYPE]
}

export function isRunTypeId(value: unknown): value is RunTypeId {
  return typeof value === 'string' && value in RUN_TYPES
}

/** O que o front precisa pra montar o dropdown. */
export function runTypeOptions(): { id: string; label: string; hint: string }[] {
  return Object.values(RUN_TYPES).map((t) => ({ id: t.id, label: t.label, hint: t.hint }))
}

// ---------- o modelo de cada papel ----------

export type ModelChoice = {
  model: AgentModel
  /** por que esse modelo, em uma linha — vai pro cabeçalho da janela */
  reason: string
}

/**
 * O modelo de um agente quando ninguém escolheu nenhum — o "auto".
 *
 * A ordem é: o que o tipo de run fixa pro papel; se ele não fixa, a tabela de
 * roteamento pelo papel do helper; e a tabela sempre termina em alguma coisa,
 * porque ela tem a linha `*` ("na dúvida, sonnet").
 *
 * Uma escolha explícita — o `model` do `spawn_helper` ou o dropdown do "novo
 * agente" — não passa por aqui: ela vence tudo, por desenho.
 */
export function defaultModelForRole(
  role: string | null | undefined,
  runTypeId: string | null | undefined,
): ModelChoice {
  const type = runType(runTypeId)
  const isLead = !role
  const pinned = isLead ? type.models.lead : type.models.helper

  if (pinned !== undefined) {
    return {
      model: pinned,
      reason: `default de ${isLead ? 'lead' : 'helper'} do run ${type.label}`,
    }
  }

  const { model, matched } = modelFromTable(role)
  return {
    model,
    reason:
      matched === '*'
        ? `tabela de roteamento: nenhum papel casou, na dúvida ${model}`
        : `tabela de roteamento: "${matched}" → ${model}`,
  }
}

// ---------- o brief do lead ----------

/**
 * Onde um brief é procurado, na ordem.
 *
 * O diretório privado vem primeiro porque é lá que mora o brief real, o que
 * cita repo interno e o documento de convenções da Oncar. O do repo é o
 * exemplo genérico, e é ele que faz o repo público funcionar de ponta a ponta
 * pra quem clonar sem ter o diretório privado.
 */
function briefCandidates(file: string): string[] {
  return [path.join(config.privateDir, 'briefs', file), path.join(repoRoot, 'briefs', file)]
}

/** O documento de convenções da arquitetura, quando ele existe. */
export function conventionsDoc(): string | null {
  const file = path.join(config.privateDir, 'convencoes-oncar.md')
  return fs.existsSync(file) ? file : null
}

/**
 * O brief do lead de um run, com os lugares preenchidos.
 *
 * Devolve `null` quando não há brief nenhum pra esse tipo — e aí o lead sobe
 * sem ninguém digitar nada nele, que é o comportamento de antes desta unidade.
 */
export function leadBrief(id: RunTypeId, ctx: RunContext): string | null {
  const type = runType(id)
  const file = briefCandidates(type.brief).find((p) => fs.existsSync(p))
  if (!file) return null

  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    console.error('falhou ler o brief do lead:', err instanceof Error ? err.message : err)
    return null
  }

  const conventions = conventionsDoc()
  const values: Record<string, string> = {
    run: ctx.runId,
    run_dir: runDir(ctx.runId),
    cwd: ctx.cwd,
    repos_root: config.reposRoot,
    max_helpers: String(config.maxHelpers),
    routing_table: routingTablePath(),
    // Sem o documento privado, o brief diz isso em vez de apontar pra um
    // caminho que não existe — um brief que manda ler um arquivo ausente faz o
    // agente gastar o primeiro turno descobrindo que ele não está lá.
    conventions: conventions ?? '(não disponível neste computador — siga o que o próprio repo mostrar)',
    subject: ctx.subject?.trim() || '(não informado — pergunte ao Enzo antes de começar)',
  }

  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole)
}
