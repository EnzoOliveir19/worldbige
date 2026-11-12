# worldbige v1 — daemon, canvas e MCP

Gerado em 2026-11-12. Fonte: docs/design.md (TDD aprovado).

## Problema

Rodar mais de um agente interativo do Claude Code hoje é uma janela de terminal por agente, nenhuma dizendo se o agente trabalha, espera permissão ou terminou. Os subagentes nativos vivem dentro da sessão do pai, sem terminal visível nem intervenção. O worldbige é o orquestrador local que resolve isso — e é também projeto de estudo do encanamento do Claude Code, com repo público.

## Abordagem

Um processo Node em `localhost:4317`, dono dos ptys dos agentes, servindo na mesma porta o front buildado, API HTTP, WebSocket de terminais e o servidor MCP. Status por hooks `http` da própria sessão. Um lead orquestra helpers via MCP; o daemon notifica o lead por injeção de stdin com fila. Front de canvas infinito (Vite + React + xterm), com pan/zoom e chrome de janela copiados do ccanvas. O TDD em docs/design.md é a autoridade de desenho; este spec é a decomposição executável dele.

## Decisões

- TypeScript em daemon e front; front com Vite + React + `@xterm/xterm`; pty com `@lydell/node-pty`.
- Servidor MCP com o SDK oficial TypeScript (`@modelcontextprotocol/sdk`), transporte HTTP em `/mcp`, identidade do agente pelo header `x-worldbige-agent`.
- Hooks todos do tipo `http` pra `POST /hooks/<agentId>`; resposta sempre neutra. Tabela de eventos → status é a do TDD, literal.
- `done`/`failed` nunca vêm de hook; `done` só pelo tool MCP. SessionEnd mapeia por `reason` (`clear`/`resume`/`prompt_input_exit` → `stopped`; `logout`/`other` → `failed`).
- Estado em arquivo JSON; scrollback em buffer circular (default 2 MB/agente); limite de helpers default 3; tudo configurável.
- Código copiado do ccanvas mantém cabeçalho de atribuição; repo sob Apache-2.0; diretório privado (material Oncar + dados de runtime) fora do git desde o primeiro commit.
- Windows nativo: detecção `claude.cmd`/`claude.exe` com override `CLAUDE_BIN`.
- Modelo por agente, escolhido no spawn e passado como `--model`. Opções: opus, sonnet, haiku, fable e "padrão da conta" — esta última não passa a flag, deixando a configuração do Enzo decidir. Cada run type define o default por papel (lead e helper), configurável; o lead pode sobrepor por helper no `spawn_helper`. O modelo em uso aparece no cabeçalho da janela, porque um agente rodando no modelo errado é invisível de outro jeito.
- Raiz dos repositórios em `REPOS_ROOT` (configurável). Agente nenhum abre na home: o lead abre na raiz, o helper num repo dentro dela, e o spawn recusa cwd fora de `REPOS_ROOT` ou da pasta do worldbige.
- Protocolo de execução: os "Done when" são verificação manual no Windows do Enzo. O executor para no fim de cada unidade, entrega o roteiro de teste e só segue depois da confirmação dele. Um commit por unidade concluída e verificada, nunca antes da verificação.
- Na unidade 5, se um dos gaps de doc falhar na prática, o executor para e reporta em vez de improvisar política; a compensação (deny mais largo ou ask enumerado) é decidida com o Enzo e o TDD ganha emenda.

## Fora de escopo

- Postar qualquer coisa no GitHub (reviews ficam locais).
- App desktop, multiusuário, acesso pela rede, autenticação no MCP além do header.
- Run types de TDD/PRD, Linear-ticket e triagem (e as integrações Linear/Slack/Drive deles).
- Testes automatizados de UI; o critério de verificação é manual, no Windows, por unidade.

## Unidades de trabalho

**1. Construir o daemon com ptys de agentes e terminal no navegador** *(tasks 1+2 do TDD)*

O chão de tudo: o processo que possui os agentes e prova que uma sessão interativa do Claude sobrevive ao front. Tem um checkpoint interno obrigatório: primeiro a TUI do Claude rodando num xterm no navegador (sem replay), o Enzo testa; só depois o buffer circular e o replay/scrollback.

Depends on: nothing

Modifies:
- repo novo: daemon, front mínimo, config, .gitignore do diretório privado

Key constraint: o pty pertence ao daemon, nunca à conexão — fechar o WebSocket não pode matar nem sinalizar a sessão.

Done when: `npm start` sobe; abrir o front, criar um agente e ver a TUI do Claude utilizável (digitar, redimensionar sem artefatos grosseiros) — checkpoint 1, verificado pelo Enzo; depois: fechar o navegador, esperar o agente responder algo, reabrir e ver o scrollback com a resposta que aconteceu sem cliente conectado — checkpoint 2, verificado pelo Enzo.

**2. Ligar hooks, máquina de status e resume** *(task 3 do TDD)*

Transforma o terminal cego em agente observável.

Depends on: unit 1

Modifies:
- geração do `--settings` temporário, endpoint de hooks, máquina de status com watchdog, persistência de `session_id`
- escolha de modelo no spawn: campo no "novo agente" (opus / sonnet / haiku / fable / padrão da conta) passado como `--model`, e o modelo em uso no cabeçalho da janela
- pasta não confiada: a tela de "trust this folder" aparece antes de qualquer hook, então um agente ali trava em `starting` sem acender `precisa de você` (achado do checkpoint 1 da unidade 1)

Key constraint: a tabela do TDD é literal — nenhum status inventado, `stale` só por silêncio além do limite, resposta de hook sempre neutra.

Done when: no Windows, com um agente aberto: mandar prompt → `running`; deixar terminar → `idle`; provocar um pedido de permissão → `precisa de você`; rodar um comando de minutos → continua `running`; matar o daemon, subir de novo → card `stopped`, e o botão de resume reabre a sessão com o histórico de conversa preservado. Abrir um agente escolhendo haiku e ver o modelo certo no cabeçalho e na sessão. Abrir um agente numa pasta nunca confiada e ver o card dizer que espera confiança, em vez de ficar `starting` calado.

**3. Copiar e podar o canvas** *(task 4 do TDD)*

A visão: canvas infinito com janelas de agente, setas e gaveta, com o destaque de `precisa de você` ligado ao status real da unidade 2.

Depends on: unit 1, unit 2

Modifies:
- front — pan/zoom, chrome de janela e fiação xterm copiados do ccanvas com atribuição; janela de agente, card recolhido, camada SVG de setas, gaveta, atalhos, destaque de `precisa de você`

Key constraint: só entra do ccanvas o que a janela de agente usa — nada de Monaco, viewers ou store gigante; os arquivos copiados carregam o cabeçalho Apache-2.0.

Done when: um run com três agentes é navegável com pan/zoom e `Ctrl+Shift+F` enquadrando; recolher vira card com status; um agente em `precisa de você` (status real, provocado por um pedido de permissão) é visivelmente o elemento mais alto da tela; as setas seguem as janelas ao arrastar.

**4. Construir o MCP de orquestração com notificação do lead** *(tasks 5+6 do TDD)*

O que faz do worldbige um orquestrador e não um multiplexador bonito.

Depends on: unit 2

Modifies:
- servidor MCP (`spawn_helper` com limite e fila, `report`, `done`, `list_helpers`, `close_helper`, `get_run`), geração do `--mcp-config` temporário, resultado salvo em markdown, fila de notificação com injeção no stdin
- `spawn_helper` ganha um `model` opcional, pro lead escolher o modelo de cada helper; sem ele, vale o default do papel definido pelo run type

Key constraint: a entrega nunca digita por cima de prompt aberto nem durante digitação do Enzo — imediata só com lead `idle`, drenagem em Stop/`idle_prompt`, supressão em `permission_prompt`.

Done when: um lead abre um helper por tool call e a seta aparece; o `done` do helper vira markdown no diretório do run; a mensagem `[worldbige]` chega ao lead nos três cenários do TDD (já idle → na hora; running → no próximo Stop; esperando permissão → só depois de resolvida). Um `spawn_helper` com `model` abre o helper naquele modelo, e um sem `model` cai no default do papel.

**5. Aplicar políticas de permissão e fechar os run types** *(tasks 7+8 do TDD)*

A última milha: o reviewer read-only de verdade e o fluxo de ponta a ponta.

Depends on: unit 3, unit 4

Modifies:
- políticas allow/ask/deny por run type com `defaultMode` forçado, briefs de lead (freeform e review de PRs), briefs de exemplo públicos, doc de convenções Oncar no diretório privado
- modelo default por papel (lead e helper) em cada run type, configurável, sobreposto pela escolha explícita no spawn ou pelo `model` do `spawn_helper`

Key constraint: os dois gaps de doc do TDD se verificam aqui, antes de confiar neles — PermissionRequest `http` com resposta neutra preservando o fluxo, e glob parcial em `ask` (ex.: `mcp__claude_ai_Linear__save_*`); se algum falhar, parar e reportar (ver protocolo de execução nas Decisões).

Done when: num reviewer, `Edit`/`Write` são negados, `gh pr diff` roda sem prompt, um tool de escrita do Linear pergunta e acende o card; um review de PR roda de ponta a ponta terminando num markdown de review no estilo Oncar; um run freeform sobe sem política. Um run type com default de helper em haiku abre os helpers em haiku sem ninguém escolher nada.

## Confirmar antes de executar

- O primeiro gesto da unidade 1 deve ser provar `@lydell/node-pty` + a TUI do `claude` num xterm no Windows, antes de construir qualquer coisa em volta — é o risco mais alto do TDD; se a fidelidade for inaceitável, o desenho volta pra mesa antes de existir código pra jogar fora.
- O endpoint de hooks responde imediatamente (ack antes de processar): SessionEnd tem orçamento default de 1,5 s e nenhum hook pode esperar o daemon trabalhar.
- Defaults (buffer 2 MB, 3 helpers, limite do watchdog) são chutes deliberados do TDD; calibrar pelo uso, não discutir no PR.
