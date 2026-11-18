// O servidor MCP: o que faz do worldbige um orquestrador e não um
// multiplexador de terminais.
//
// Um lead abre helpers por tool call, acompanha o que eles dizem e recebe o
// resultado deles — tudo sem ninguém clicar em nada. O daemon sabe QUEM está
// chamando pelo header `x-worldbige-agent` que o `--mcp-config` da sessão
// carrega; sem ele uma tool call seria anônima e não haveria o que orquestrar.
//
// O transporte é stateless de propósito. A identidade vem no header de CADA
// requisição, então não há o que guardar entre uma e outra: um servidor por
// requisição é mais simples que uma sessão MCP com ciclo de vida próprio, e não
// deixa sessão órfã quando um agente morre.
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { config } from './config.js'
import { AGENT_HEADER } from './mcp-config.js'
import { CwdRefused } from './cwd.js'
import { onAgentsChanged } from './events.js'
import {
  createAgent,
  getAgent,
  listAgents,
  markDone,
  parseModel,
  sendToAgent,
  setAgentNote,
  stopAgent,
  type Agent,
  type AgentModel,
} from './agents.js'
import { doneNotice, reportNotice } from './outbox.js'
import { freePath, runDir, slug, writeRunFile } from './runs.js'

// ---------- a fila de spawn ----------
//
// Um run tem um teto de helpers simultâneos. Acima dele o spawn não bloqueia e
// não falha: entra numa fila e o tool devolve "na fila". Bloquear esbarraria no
// timeout de tool do cliente, e falhar faria o lead tratar lotação como erro.

type QueuedSpawn = {
  runId: string
  parentId: string
  name: string
  role: string
  brief: string
  briefFile: string
  cwd: string
  /** `undefined` = o lead não escolheu: decide o tipo de run / a tabela */
  model: AgentModel | undefined
  modelReason: string | null
}

const queue: QueuedSpawn[] = []

/**
 * Os helpers que ocupam vaga no run.
 *
 * Quem decide isso é o `done`, não o pty. Um helper que concluiu não está mais
 * trabalhando, e a janela dele continua aberta porque o resultado ainda está
 * sendo lido — fazer a vaga depender de fechar a janela obrigaria a limpar a
 * tela pra fila andar, que foi o que travou o run do teste em 3/3.
 *
 * Um helper parado ou morto também não ocupa: só conta quem tem sessão viva e
 * ainda não concluiu.
 */
function busyHelpers(runId: string): Agent[] {
  return listAgents().filter(
    (a) => a.runId === runId && a.parentId && a.live && a.status !== 'done',
  )
}

function queuedFor(runId: string): QueuedSpawn[] {
  return queue.filter((q) => q.runId === runId)
}

function openHelper(spawn: QueuedSpawn): Agent {
  const helper = createAgent({
    name: spawn.name,
    role: spawn.role,
    runId: spawn.runId,
    parentId: spawn.parentId,
    model: spawn.model,
    modelReason: spawn.modelReason,
    ...(spawn.cwd ? { cwd: spawn.cwd } : {}),
  })
  // O prompt inicial é UMA LINHA apontando pro arquivo, não o brief inteiro:
  // o brief fica editável até o spawn e o transcript começa limpo em vez de
  // nascer com uma página de texto colada dentro.
  //
  // Vai pela mesma fila da notificação porque tem o mesmo perigo: a TUI ainda
  // não subiu quando o pty nasce, e texto digitado antes dela se perde. Sai
  // quando o helper chegar a `idle` — numa pasta não confiada, espera a tela
  // de confiança ser respondida em vez de sumir.
  sendToAgent(
    helper.id,
    'brief',
    `Leia seu brief em ${spawn.briefFile} e siga.`,
    Date.now() + config.briefGraceMs,
  )
  return helper
}

let draining = false

/**
 * Abre o que couber da fila.
 *
 * Chamado a cada mudança na lista de agentes: um helper que concluiu, foi
 * fechado ou morreu libera uma vaga, e a vaga livre é justamente o que a fila
 * espera. A reentrância é barrada porque abrir um helper muda a lista de
 * agentes, o que chamaria esta função de dentro dela mesma.
 */
function drainQueue(): void {
  if (draining || !queue.length) return
  draining = true
  try {
    for (;;) {
      const next = queue.find((q) => busyHelpers(q.runId).length < config.maxHelpers)
      if (!next) break
      // Um lead que sumiu enquanto o pedido esperava não abre mais nada.
      if (!getAgent(next.parentId)) {
        queue.splice(queue.indexOf(next), 1)
        continue
      }
      queue.splice(queue.indexOf(next), 1)
      try {
        const helper = openHelper(next)
        console.log(`  fila: ${helper.name} saiu da fila e abriu`)
      } catch (err) {
        console.error('falhou abrir helper da fila:', err instanceof Error ? err.message : err)
      }
    }
  } finally {
    draining = false
  }
}

onAgentsChanged(() => drainQueue())

// ---------- as respostas dos tools ----------

type ToolReply = { content: { type: 'text'; text: string }[]; isError?: boolean }

function say(text: string): ToolReply {
  return { content: [{ type: 'text', text }] }
}

function fail(text: string): ToolReply {
  return { content: [{ type: 'text', text }], isError: true }
}

/** Como um agente aparece numa listagem pro lead. */
function describe(agent: Agent): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    model: agent.model ?? 'padrão da conta',
    ...(agent.modelReason ? { model_reason: agent.modelReason } : {}),
    cwd: agent.cwd,
    live: agent.live,
    ...(agent.waitingTool ? { waiting_tool: agent.waitingTool } : {}),
    ...(agent.note ? { last_report: `${agent.note.status}: ${agent.note.summary}` } : {}),
  }
}

/** A primeira linha que preste de um texto — o resumo de um `done`. */
function firstLine(text: string, fallback: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (line) return line.length > 200 ? `${line.slice(0, 200)}…` : line
  }
  return fallback
}

/** Termina em ponto final: a notificação do lead é uma frase, não um fragmento. */
function sentence(text: string): string {
  const t = text.trim()
  return /[.!?…]$/.test(t) ? t : `${t}.`
}

// ---------- o servidor ----------

function buildServer(caller: Agent): McpServer {
  const server = new McpServer(
    { name: 'worldbige', version: '0.1.0' },
    {
      instructions:
        'Orquestração do worldbige. Você é o agente "' +
        caller.name +
        '". Abra helpers com spawn_helper, acompanhe com list_helpers e get_run, ' +
        'conte o que está fazendo com report, e termine com done — é o done que ' +
        'salva seu resultado e avisa quem te abriu.',
    },
  )

  server.registerTool(
    'spawn_helper',
    {
      title: 'abrir um helper',
      description:
        'Abre um agente Claude Code auxiliar neste run, com um brief próprio. ' +
        'Devolve o id dele. Se o run já estiver no limite de helpers simultâneos, ' +
        'o pedido entra numa fila e abre sozinho quando uma vaga liberar.',
      inputSchema: {
        name: z.string().min(1).describe('nome curto, como ele aparece no canvas'),
        role: z
          .string()
          .min(1)
          .describe('o papel dele: review, busca, skeptic, triagem…'),
        brief: z
          .string()
          .min(1)
          .describe('o que ele tem que fazer, em markdown; vira um arquivo que ele lê'),
        cwd: z
          .string()
          .optional()
          .describe('repo onde ele abre; sem isso, a mesma pasta em que você está'),
        after: z
          .string()
          .optional()
          .describe('id do agente de que este depende; sem isso, você mesmo'),
        model: z
          .enum(['opus', 'sonnet', 'haiku', 'fable'])
          .optional()
          .describe(
            'o modelo dele, pela tabela de roteamento: review de PR e arquitetura → opus; ' +
              'busca, resumo e triagem → sonnet; skeptic e bug difícil → fable; na dúvida, sonnet. ' +
              'Sem isso, vale o default do papel.',
          ),
        model_reason: z
          .string()
          .optional()
          .describe('uma linha dizendo por que esse modelo; aparece no cabeçalho da janela'),
      },
    },
    async (args) => {
      const after = args.after?.trim()
      // Um `after` que não existe é erro de endereço, não motivo pra pendurar o
      // helper em quem chamou: o lead precisa saber que errou o id.
      if (after && !getAgent(after)) {
        return fail(`Não existe agente com id ${after}. Veja os ids em list_helpers.`)
      }
      const parentId = after || caller.id
      // Sem `model`, não se decide nada aqui: o `undefined` desce até o
      // `createAgent`, que é o único lugar onde "auto" é resolvido — pelo
      // default do papel no tipo de run, e pela tabela de roteamento no fim.
      // Resolver nos dois lugares daria duas respostas pra mesma pergunta.
      const model = args.model ? parseModel(args.model) : undefined
      const briefFile = await writeRunFile(
        caller.runId,
        path.join('briefs', `${slug(args.name)}-${Date.now().toString(36)}.md`),
        `# ${args.name}\n\n_papel: ${args.role}_\n\n${args.brief.trim()}\n`,
      )

      const spawn: QueuedSpawn = {
        runId: caller.runId,
        parentId,
        name: args.name,
        role: args.role,
        brief: args.brief,
        briefFile,
        // Sem `cwd`, o helper abre ONDE QUEM O ABRIU está — não na raiz dos
        // repositórios. Um lead trabalhando num repo que delega uma busca
        // espera a busca nesse repo; cair na raiz faria o helper procurar no
        // lugar errado sem ninguém notar.
        cwd: args.cwd?.trim() || caller.cwd,
        model,
        modelReason: args.model_reason?.trim() || null,
      }

      if (busyHelpers(caller.runId).length >= config.maxHelpers) {
        queue.push(spawn)
        const place = queuedFor(caller.runId).length
        return say(
          `Na fila, posição ${place}: o run já está com ${config.maxHelpers} ` +
            `helper${config.maxHelpers > 1 ? 's' : ''} trabalhando, que é o limite. ` +
            `"${args.name}" abre sozinho assim que um deles chamar done ou for fechado — ` +
            'não é preciso fechar a janela de ninguém. ' +
            `O brief já está em ${briefFile}. Não repita o pedido.`,
        )
      }

      try {
        const helper = openHelper(spawn)
        return say(
          JSON.stringify(
            {
              id: helper.id,
              name: helper.name,
              model: helper.model ?? 'padrão da conta',
              // Quando o lead não escolheu, o motivo diz qual regra escolheu
              // por ele — a linha da tabela que casou, ou o default do tipo de
              // run. É o mesmo texto que aparece no cabeçalho da janela.
              model_reason: helper.modelReason,
              cwd: helper.cwd,
              brief: briefFile,
              note: 'Ele já recebeu a ordem de ler o brief. Acompanhe com list_helpers.',
            },
            null,
            2,
          ),
        )
      } catch (err) {
        // Um cwd recusado é erro de pedido, e a mensagem explica a fronteira —
        // é o que o lead precisa pra corrigir sozinho.
        if (err instanceof CwdRefused) return fail(err.message)
        throw err
      }
    },
  )

  server.registerTool(
    'report',
    {
      title: 'contar o que está acontecendo',
      description:
        'Atualiza o seu card no canvas com uma linha de progresso, e avisa quem te ' +
        'abriu. É o canal de progresso: use quando terminar uma etapa ou travar.',
      inputSchema: {
        status: z.string().min(1).describe('uma palavra: trabalhando, travado, revisando…'),
        summary: z.string().min(1).describe('uma linha sobre onde você está'),
      },
    },
    async (args) => {
      const me = getAgent(caller.id)
      if (!me) return fail('Este agente não existe mais no daemon.')
      setAgentNote(me.id, args.status, args.summary)
      notifyParent(me, reportNotice(me.name, args.status, sentence(args.summary)))
      return say('Anotado no seu card.')
    },
  )

  server.registerTool(
    'done',
    {
      title: 'concluir',
      description:
        'Encerra o seu trabalho: salva o resultado como markdown no diretório do run, ' +
        'marca o seu card como concluído e avisa quem te abriu. Chame uma vez só, ' +
        'quando o trabalho estiver pronto — é a única coisa que marca um agente como concluído.',
      inputSchema: {
        result: z
          .string()
          .min(1)
          .describe('o seu resultado, em markdown; a primeira linha vira o resumo'),
        worktrees: z
          .array(z.string())
          .optional()
          .describe('caminhos que você mexeu, se mexeu em algum'),
      },
    },
    async (args) => {
      const me = getAgent(caller.id)
      if (!me) return fail('Este agente não existe mais no daemon.')

      const dir = runDir(me.runId)
      const file = await freePath(dir, `${slug(me.name)}-${me.id.slice(0, 8)}`, '.md')
      const head = [
        `# ${me.name}`,
        '',
        `- agente: \`${me.id}\``,
        `- papel: ${me.role ?? '—'}`,
        `- modelo: ${me.model ?? 'padrão da conta'}${me.modelReason ? ` (${me.modelReason})` : ''}`,
        `- diretório: \`${me.cwd}\``,
        `- concluído em: ${new Date().toISOString()}`,
        ...(args.worktrees?.length
          ? ['- mexeu em:', ...args.worktrees.map((w) => `  - \`${w}\``)]
          : []),
        '',
        '---',
        '',
      ].join('\n')
      await writeRunFile(me.runId, path.relative(dir, file), head + args.result.trim() + '\n')

      const summary = firstLine(args.result, 'concluiu')
      markDone(me.id, summary)
      const told = notifyParent(me, doneNotice(me.name, sentence(summary), file))
      // Um lead não tem a quem avisar, e dizer que avisou seria mentira: quem
      // lê o resultado dele é o Enzo, no card do canvas.
      return say(`Salvo em ${file}.` + (told ? ' Quem te abriu foi avisado.' : ''))
    },
  )

  server.registerTool(
    'list_helpers',
    {
      title: 'listar os agentes do run',
      description: 'Quem está aberto neste run, com status, modelo e o último report de cada um.',
      inputSchema: {},
    },
    async () => {
      const mine = listAgents().filter((a) => a.runId === caller.runId)
      const waiting = queuedFor(caller.runId)
      return say(
        JSON.stringify(
          {
            helpers: mine.filter((a) => a.parentId).map(describe),
            leads: mine.filter((a) => !a.parentId).map(describe),
            na_fila: waiting.map((q) => ({ name: q.name, role: q.role })),
            limite: config.maxHelpers,
          },
          null,
          2,
        ),
      )
    },
  )

  server.registerTool(
    'close_helper',
    {
      title: 'fechar um helper',
      description:
        'Encerra a sessão de um helper deste run. O card dele fica no canvas com o que ' +
        'ele produziu, e a vaga liberada deixa a fila andar.',
      inputSchema: { id: z.string().min(1).describe('o id que o spawn_helper devolveu') },
    },
    async (args) => {
      const target = getAgent(args.id)
      if (!target || target.runId !== caller.runId) {
        return fail(`Não existe helper com id ${args.id} neste run.`)
      }
      if (!target.parentId) return fail('Esse agente é um lead, não um helper.')
      if (target.id === caller.id) return fail('Pra encerrar o seu próprio trabalho, use done.')
      stopAgent(target.id)
      return say(`"${target.name}" encerrado.`)
    },
  )

  server.registerTool(
    'get_run',
    {
      title: 'o run inteiro',
      description: 'Onde este run guarda o que produz, há quanto tempo corre e quem está nele.',
      inputSchema: {},
    },
    async () => {
      const mine = listAgents().filter((a) => a.runId === caller.runId)
      const since = mine.length ? Math.min(...mine.map((a) => a.createdAt)) : Date.now()
      return say(
        JSON.stringify(
          {
            run: caller.runId,
            diretório: runDir(caller.runId),
            aberto_há_s: Math.round((Date.now() - since) / 1000),
            você: describe(caller),
            agentes: mine.map(describe),
            helpers_ocupando_vaga: busyHelpers(caller.runId).length,
            limite: config.maxHelpers,
            na_fila: queuedFor(caller.runId).length,
          },
          null,
          2,
        ),
      )
    },
  )

  return server
}

/**
 * Avisa quem abriu este agente.
 *
 * A entrega é por injeção no stdin do lead, com a regra da fila: imediata se
 * ele já estiver livre, senão no próximo Stop ou `idle_prompt`, nunca por cima
 * de um prompt de permissão. Um agente raiz não tem a quem avisar — o Enzo lê
 * o card no canvas.
 */
function notifyParent(agent: Agent, text: string): boolean {
  if (!agent.parentId) return false
  const lead = getAgent(agent.parentId)
  if (!lead) return false
  sendToAgent(lead.id, 'notice', text)
  return true
}

// ---------- a entrada HTTP ----------

function headerAgent(req: IncomingMessage): Agent | null {
  const raw = req.headers[AGENT_HEADER]
  const id = Array.isArray(raw) ? raw[0] : raw
  if (!id) return null
  return getAgent(id.trim())
}

/**
 * Trata uma requisição em `/mcp`.
 *
 * Um servidor e um transporte por requisição: o estado que importaria entre
 * chamadas é a identidade do agente, e ela vem no header de cada uma.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: string,
): Promise<void> {
  const caller = headerAgent(req)
  if (!caller) {
    // Sem identidade não há orquestração possível: o servidor não teria como
    // saber de quem é o run, nem a quem avisar quando o trabalho terminar.
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        error:
          `requisição sem o header ${AGENT_HEADER}, ou com um agente que o daemon não conhece. ` +
          'Esse header vem do --mcp-config que o worldbige gera pra cada sessão.',
      }),
    )
    return
  }

  let body: unknown
  try {
    body = rawBody ? JSON.parse(rawBody) : undefined
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'corpo não é JSON' }))
    return
  }

  const server = buildServer(caller)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  // O transporte morre com a requisição; fechar o servidor junto é o que evita
  // acumular um McpServer por tool call atendida.
  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  } catch (err) {
    console.error('erro no MCP:', err instanceof Error ? err.message : err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'falha no servidor MCP' }))
    }
  }
}
