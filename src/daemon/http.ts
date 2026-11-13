// A camada HTTP: front buildado, API do front e, nas unidades seguintes, os
// hooks e o MCP — tudo na mesma porta, porque o daemon é um processo só.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { config } from './config.js'
import {
  screenStats,
  createAgent,
  getAgent,
  handleHookEvent,
  listAgents,
  parseModel,
  removeAgent,
  resumeAgent,
  setLayout,
  stopAgent,
  type AgentLayout,
} from './agents.js'
import type { HookEvent } from './status.js'
import { allowedRoots, CwdRefused } from './cwd.js'
import { handleMcpRequest } from './mcp.js'
import { isRunTypeId, runTypeOptions } from './run-types.js'

export function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1 << 20) reject(new Error('corpo grande demais'))
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** Serve o front buildado. Sem build, explica em vez de dar 404 seco. */
async function serveStatic(url: URL, res: ServerResponse): Promise<void> {
  const root = config.frontDir
  if (!fs.existsSync(root)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Front não buildado. Rode `npm run build:front` (ou `npm start`).\n')
    return
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  let file = path.join(root, rel)
  // Nunca deixa a URL escapar do diretório do front.
  if (!file.startsWith(root)) file = root
  if (!rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(root, 'index.html')
  }
  try {
    const data = await fsp.readFile(file)
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.byteLength,
    })
    res.end(data)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('não encontrado\n')
  }
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`)
  const { pathname } = url

  try {
    // ---- hooks ----
    // Responde ANTES de processar. O SessionEnd tem orçamento de ~1,5 s e
    // nenhum hook pode esperar o daemon trabalhar; a resposta é sempre neutra,
    // sem corpo de decisão, pro prompt de permissão seguir o fluxo normal.
    const hook = /^\/hooks\/([^/]+)$/.exec(pathname)
    if (hook && req.method === 'POST') {
      const agentId = hook[1] as string
      // O corpo já está a caminho: lê, responde, e só então trabalha. Ler não
      // é processar; o que não pode é a sessão esperar a máquina de status.
      let raw = ''
      try {
        raw = await readBody(req)
      } catch {
        /* corpo truncado — responde mesmo assim */
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')

      setImmediate(() => {
        try {
          handleHookEvent(agentId, raw ? (JSON.parse(raw) as HookEvent) : {})
        } catch (err) {
          console.error('hook ilegível:', err instanceof Error ? err.message : err)
        }
      })
      return
    }
    // ---- MCP ----
    // Mesma porta do resto, porque o daemon é um processo só. Quem fala aqui
    // são os agentes, não o front: a identidade vem do header que o
    // `--mcp-config` de cada sessão carrega.
    if (pathname === '/mcp') {
      // O corpo é lido aqui e entregue já parseado ao transporte — ler duas
      // vezes o mesmo stream devolveria vazio na segunda.
      const raw = req.method === 'POST' ? await readBody(req) : ''
      await handleMcpRequest(req, res, raw)
      return
    }

    if (pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        platform: process.platform,
        pid: process.pid,
        agents: listAgents().length,
        buffer: screenStats(),
        reposRoot: config.reposRoot,
        allowedRoots: allowedRoots(),
        // A gaveta desenha um ponto por vaga de helper; sem o limite ela não
        // tem como dizer quantas vagas existem.
        maxHelpers: config.maxHelpers,
        // Os tipos de run vêm do daemon e não de uma lista no front: quem sabe
        // quais existem é quem carrega as políticas e os briefs, e acrescentar
        // um tipo não pode exigir editar o front junto.
        runTypes: runTypeOptions(),
        uptimeMs: Math.round(process.uptime() * 1000),
      })
    }

    if (pathname === '/api/agents' && req.method === 'GET') {
      return json(res, 200, { agents: listAgents() })
    }

    if (pathname === '/api/agents' && req.method === 'POST') {
      const raw = await readBody(req)
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      // O dropdown começa em "auto", que quer dizer "o default do tipo de
      // run". Por isso `auto` vira `undefined` e NÃO `null`: `null` é a outra
      // opção do dropdown, "padrão da conta", que é uma escolha explícita de
      // não passar `--model`. As duas somem no mesmo valor se a gente não
      // separar aqui, e aí o "auto" nunca aconteceria.
      const wanted = typeof body.model === 'string' ? body.model : 'auto'
      const agent = createAgent({
        name: typeof body.name === 'string' ? body.name : undefined,
        cwd: typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined,
        cols: typeof body.cols === 'number' ? body.cols : undefined,
        rows: typeof body.rows === 'number' ? body.rows : undefined,
        ...(wanted === 'auto' ? {} : { model: parseModel(wanted) }),
        // O tipo do run decide política, brief do lead e modelo por papel.
        // Só vale pro agente raiz: um helper herda o de quem o abriu.
        ...(isRunTypeId(body.runType) ? { runType: body.runType } : {}),
        ...(typeof body.subject === 'string' && body.subject.trim()
          ? { subject: body.subject.trim() }
          : {}),
        // Quem abriu este agente. Hoje vem do botão de helper no canvas; na
        // unidade 4 vai vir do `after` do `spawn_helper`, pelo mesmo campo.
        parentId: typeof body.parentId === 'string' && body.parentId ? body.parentId : null,
        // O front manda o lugar quando a janela já está na tela medindo o
        // terminal; sem isso o daemon escolhe (abaixo do pai, à direita do irmão).
        ...(body.layout && typeof body.layout === 'object'
          ? { layout: body.layout as Partial<AgentLayout> }
          : {}),
        // Uma política explícita, que vence a do tipo de run. Não tem botão no
        // front: é o cano por onde um teste provoca uma política à mão sem
        // precisar inventar um tipo de run pra isso.
        ...(body.permissions && typeof body.permissions === 'object'
          ? { permissions: body.permissions as Record<string, unknown> }
          : {}),
      })
      return json(res, 201, { agent })
    }

    const one = /^\/api\/agents\/([^/]+)$/.exec(pathname)
    if (one) {
      const id = one[1] as string
      if (req.method === 'GET') {
        const agent = getAgent(id)
        return agent ? json(res, 200, { agent }) : json(res, 404, { error: 'agente não encontrado' })
      }
      if (req.method === 'DELETE') {
        return removeAgent(id)
          ? json(res, 200, { ok: true })
          : json(res, 404, { error: 'agente não encontrado' })
      }
    }

    // Onde a janela está no canvas. É PATCH e não PUT porque o front manda só o
    // que mudou — arrastar manda x/y, redimensionar manda w/h, clicar manda z.
    const layout = /^\/api\/agents\/([^/]+)\/layout$/.exec(pathname)
    if (layout && (req.method === 'PATCH' || req.method === 'POST')) {
      const id = layout[1] as string
      const raw = await readBody(req)
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const patch: Partial<AgentLayout> = {}
      for (const key of ['x', 'y', 'w', 'h', 'z'] as const) {
        if (typeof body[key] === 'number') patch[key] = body[key]
      }
      if (typeof body.collapsed === 'boolean') patch.collapsed = body.collapsed
      // `pinned: false` é o botão de realinhar — o único jeito de uma janela
      // arrastada voltar pro arranjo automático. Sem passar por aqui, o botão
      // existiria na tela e não faria nada.
      if (typeof body.pinned === 'boolean') patch.pinned = body.pinned
      const agent = setLayout(id, patch)
      return agent ? json(res, 200, { agent }) : json(res, 404, { error: 'agente não encontrado' })
    }

    const resume = /^\/api\/agents\/([^/]+)\/resume$/.exec(pathname)
    if (resume && req.method === 'POST') {
      const id = resume[1] as string
      const agent = getAgent(id)
      if (!agent) return json(res, 404, { error: 'agente não encontrado' })
      if (!agent.sessionId) {
        return json(res, 409, {
          error: 'esse agente nunca registrou um session_id, então não há sessão pra resumir.',
        })
      }
      const back = resumeAgent(id)
      return back ? json(res, 200, { agent: back }) : json(res, 409, { error: 'não deu pra resumir' })
    }

    // Encerra o pty mas guarda a ficha — o agente fica `stopped`, resumível.
    const stop = /^\/api\/agents\/([^/]+)\/stop$/.exec(pathname)
    if (stop && req.method === 'POST') {
      const id = stop[1] as string
      return stopAgent(id)
        ? json(res, 200, { ok: true, agent: getAgent(id) })
        : json(res, 404, { error: 'agente não encontrado' })
    }

    if (pathname.startsWith('/api/')) {
      return json(res, 404, { error: 'rota não encontrada' })
    }

    return await serveStatic(url, res)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Um cwd recusado é pedido inválido, não falha do daemon — e a mensagem
    // explica qual é a fronteira, porque é ela que o usuário precisa entender.
    if (err instanceof CwdRefused) return json(res, 400, { error: message })
    console.error('erro na requisição', pathname, message)
    return json(res, 500, { error: message })
  }
}
