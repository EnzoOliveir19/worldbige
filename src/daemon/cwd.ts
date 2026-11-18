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

/** Caminhos iguais têm a mesma chave — no Windows, caixa não diferencia. */
function key(p: string): string {
  const full = path.resolve(p)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

export function allowedRoots(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // REPOS_ROOT pode ser a pasta que contém o worldbige — aí é uma raiz só.
  for (const root of [config.reposRoot, repoRoot]) {
    if (seen.has(key(root))) continue
    seen.add(key(root))
    out.push(path.resolve(root))
  }
  return out
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Onde um nome relativo pode estar, na ordem de preferência.
 *
 * REPOS_ROOT primeiro, porque é a raiz dos repos e o caso comum. Depois as
 * outras raízes — incluindo o caso em que a raiz é ela mesma o repo procurado:
 * com REPOS_ROOT em C:\dev e o worldbige em C:\dev\worldbige, "worldbige" tem
 * que achar a raiz, e não uma pasta inexistente dentro dela.
 */
function candidatesFor(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (p: string): void => {
    if (seen.has(key(p))) return
    seen.add(key(p))
    out.push(path.resolve(p))
  }
  for (const root of allowedRoots()) {
    add(path.resolve(root, raw))
    if (key(path.basename(root)) === key(raw)) add(root)
  }
  return out
}

/** Confere a fronteira e o tipo de um caminho já resolvido. */
function accept(resolved: string): string {
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

/**
 * Resolve o diretório de um agente. Sem pedido, é REPOS_ROOT — o lugar do lead.
 * Com pedido, tem que estar debaixo de uma das raízes permitidas e existir.
 *
 * Um nome curto é procurado em TODAS as raízes, não só em REPOS_ROOT: as raízes
 * são duas justamente porque os repos podem não estar todos no mesmo lugar, e
 * um nome que só funciona numa delas transforma a outra em caminho completo
 * obrigatório. Se o nome existir em mais de uma raiz, o daemon recusa e mostra
 * quais — escolher sozinho abriria o agente no repo errado sem avisar.
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

  if (path.isAbsolute(raw)) return accept(path.resolve(raw))

  const roots = allowedRoots()
  const candidates = candidatesFor(raw)
  const inside = candidates.filter((p) => roots.some((root) => contains(root, p)))

  // Um relativo que sobe demais (`..\outra-coisa`) não sobrou nenhum candidato
  // dentro das raízes: a recusa tem que falar da fronteira, não de não achar.
  if (!inside.length) return accept(path.resolve(roots[0] as string, raw))

  const found = inside.filter(isDirectory)

  if (found.length > 1) {
    throw new CwdRefused(
      `"${raw}" existe em mais de uma raiz: ${found.join(' e ')}. ` +
        'Escrever o caminho completo diz qual você quer.',
    )
  }
  if (!found.length) {
    throw new CwdRefused(
      `Não achei "${raw}" nas raízes permitidas. Procurei em: ${inside.join(', ')}.`,
    )
  }
  return accept(found[0] as string)
}
