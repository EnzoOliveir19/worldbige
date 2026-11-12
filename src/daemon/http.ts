// A camada HTTP: front buildado, API do front e, nas unidades seguintes, os
// hooks e o MCP — tudo na mesma porta, porque o daemon é um processo só.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { config } from './config.js'
import { screenStats, createAgent, getAgent, listAgents, removeAgent, stopAgent } from './agents.js'
import { allowedRoots, CwdRefused } from './cwd.js'

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
    if (pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        platform: process.platform,
        pid: process.pid,
        agents: listAgents().length,
        buffer: screenStats(),
        reposRoot: config.reposRoot,
        allowedRoots: allowedRoots(),
        uptimeMs: Math.round(process.uptime() * 1000),
      })
    }

    if (pathname === '/api/agents' && req.method === 'GET') {
      return json(res, 200, { agents: listAgents() })
    }

    if (pathname === '/api/agents' && req.method === 'POST') {
      const raw = await readBody(req)
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const agent = createAgent({
        name: typeof body.name === 'string' ? body.name : undefined,
        cwd: typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined,
        cols: typeof body.cols === 'number' ? body.cols : undefined,
        rows: typeof body.rows === 'number' ? body.rows : undefined,
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
