// Onde um agente pode abrir.
//
// Duas raízes, e só elas: REPOS_ROOT, onde moram os repositórios, e o próprio
// worldbige, pra ele poder trabalhar em si mesmo. Fora disso o spawn é recusado
// em vez de silenciosamente cair na home — uma sessão aberta no perfil do
// usuário enxerga a árvore inteira, inclusive o que não é código.
import fs from 'node:fs'
import path from 'node:path'
import { config, repoRoot } from './config.js'

export class CwdRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CwdRefused'
  }
}

/** `child` está dentro de `root` (ou é o próprio root)? */
function contains(root: string, child: string): boolean {
  const rel = path.relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function allowedRoots(): string[] {
  return [config.reposRoot, repoRoot]
}

/**
 * Resolve o diretório de um agente. Sem pedido, é REPOS_ROOT — o lugar do lead.
 * Com pedido, tem que estar debaixo de uma das raízes permitidas e existir.
 */
export function resolveAgentCwd(requested?: string | null): string {
  const raw = requested?.trim()
  if (!raw) {
    if (!fs.existsSync(config.reposRoot)) {
      throw new CwdRefused(
        `REPOS_ROOT aponta pra "${config.reposRoot}", que não existe. Ajuste a variável REPOS_ROOT.`,
      )
    }
    return config.reposRoot
  }

  // Um nome solto é lido como repo dentro de REPOS_ROOT: "worldbige" → <raiz>/worldbige.
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(config.reposRoot, raw)

  const roots = allowedRoots()
  if (!roots.some((root) => contains(root, resolved))) {
    throw new CwdRefused(
      `"${resolved}" está fora das raízes permitidas (${roots.join(', ')}). ` +
        'Um agente só abre num repo de REPOS_ROOT ou na pasta do worldbige.',
    )
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new CwdRefused(`"${resolved}" não existe.`)
  }
  if (!stat.isDirectory()) throw new CwdRefused(`"${resolved}" não é um diretório.`)

  return resolved
}
