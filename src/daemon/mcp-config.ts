// O `--mcp-config` temporário de cada agente.
//
// É o par do `--settings`: um aponta os hooks pra `/hooks/<agentId>`, o outro
// aponta o MCP pra `/mcp` com o header `x-worldbige-agent: <agentId>`. Os dois
// existem pelo mesmo motivo — o daemon precisa saber QUAL agente está falando,
// e nem hook nem tool call carregam essa informação por conta própria. No hook
// a identidade está na URL; aqui está no header.
//
// `--mcp-config` ACRESCENTA aos servidores que a conta já tem, não os
// substitui, então o agente continua com os conectores normais do Enzo. É o
// contrário de `--strict-mcp-config`, que o TDD considerou e descartou: cortar
// tudo levaria junto a leitura do Linear que um review precisa.
import fs from 'node:fs'
import path from 'node:path'
import { config, paths } from './config.js'

/** Como o servidor do worldbige se chama dentro da sessão do agente. */
export const MCP_SERVER_NAME = 'worldbige'

/** O header que diz quem está chamando. */
export const AGENT_HEADER = 'x-worldbige-agent'

/**
 * Os tools, com o prefixo que o Claude Code dá a tool de MCP. É isto que a
 * política de permissão da unidade 5 vai nomear nas listas de allow/deny.
 */
export function toolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`
}

export function writeAgentMcpConfig(agentId: string): string {
  const body = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: `http://${config.host}:${config.port}/mcp`,
        headers: { [AGENT_HEADER]: agentId },
      },
    },
  }
  const dir = paths.tmp()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `mcp-${agentId}.json`)
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
  return file
}

export function removeAgentMcpConfig(agentId: string): void {
  try {
    fs.rmSync(path.join(paths.tmp(), `mcp-${agentId}.json`), { force: true })
  } catch {
    /* já sumiu */
  }
}
