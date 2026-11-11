# Handoff — Ponte Cursor para Telegram

Atualizado em 2026-11-11. Versão 1.0.0. Serviço local, sem tela e sem dependência npm. Node 22. Código em inglês. Textos do Telegram e este arquivo em pt-BR.

Não é o Mercado. Não captura pagamento, não usa gateway e não lê o repositório `mercado` para autorizar nada.

## Onde está

| Peça | Caminho |
| --- | --- |
| Código | `/home/luizdeangeli/Projetos/cursor-remote` |
| Segredos | `.env` modo 600. Não commitar. Modelo em `.env.example` |
| Estado | `data/state.json` (gitignored), versão 2. Cópias em `.bak1`–`.bak3`. JSON inválido vai para `state.json.corrupt-<hora>` |
| Bloqueio | `data/bridge.lock`. Pid morto é bloqueio abandonado. Pid vivo recusa a segunda instância |
| Diagnóstico local | `npm run diagnostico` quando o Telegram não responde. Não imprime o token |
| Seletores do DOM | `selectors.json` |
| Serviço | `systemctl --user status cursor-telegram.service` |
| Unidade | `~/.config/systemd/user/cursor-telegram.service` |
| Abrir o Cursor na porta | `bin/cursor-debug` |
| Testes | `node --test` na pasta do projeto |

O Cursor precisa estar aberto com `--remote-debugging-port=9222`. `bin/cursor-debug` só acrescenta `--no-sandbox` quando `chrome-sandbox` não tem setuid. O atalho do menu não liga a porta. Um segundo `cursor` enquanto já existe um processo principal imprime “DevTools listening” e sai; a porta morre. Feche pelo Quit e abra de novo com `bin/cursor-debug`. Conferir em `http://127.0.0.1:9222/json`.

## O que faz

Long polling do Bot API. Um tópico do grupo por conversa de agente. O General (thread 1) só aceita comando. Texto livre num tópico vai para aquela conversa. Tópico desconhecido, fechado, aposentado ou ambíguo é recusado com explicação. Não cai na aba ativa.

Usuário e grupo vazios não aceitam o primeiro remetente. O terminal imprime `/parear CODIGO`. Só esse comando autoriza a conta e o chat.

`COMPARTILHAR=todas` cria tópico para cada conversa visível. `COMPARTILHAR=escolhidas` só cria depois de Incluir em Projetos. No modo `todas`, `/recarregar` marca conversa ausente como fechada e não chama `deleteForumTopic`. Lista incompleta ou janela com erro não conta como exclusão. No modo `escolhidas`, `/recarregar` apaga os tópicos e a seleção. A exclusão definitiva no modo `todas` é `/esquecer`, com botão de confirmação.

A ponte responde **Recebido pela ponte. Aguardando envio.** e só depois **Recebido pelo Cursor.**, quando o texto aparece na conversa confirmada. Rascunho no campo bloqueia o envio. Resultado incerto não é reenviado sozinho.

Aprovação tem id aleatório, vale 15 minutos e exige o mesmo usuário, chat, tópico e o mesmo pedido ainda visível. Botão antigo não aprova um pedido novo com o mesmo texto.

Enquanto o agente trabalha, uma mensagem “Trabalhando…” é editada. Quando a resposta fica pronta, essa mensagem é apagada e o texto final entra como mensagem nova. Texto acima do que o Cursor mostrou traz aviso explícito. O corte silencioso de 8.000 caracteres saiu.

## Decisões que não se desfazem sem motivo

- A chave padrão continua `pasta::id da conversa`, para os tópicos já criados não trocarem de lugar. O caminho do workspace só entra na chave quando duas janelas abertas têm o mesmo nome de pasta e cada uma tem um caminho distinto. Sem caminhos distintos, o vínculo fica ambíguo e a ponte não escolhe destino. Id estável (`data-composer-id`, `data-agent-id` ou `data-conversation-id`) preserva o tópico na renomeação.
- A fila vive no mesmo `state.json`, no mesmo processo e no mesmo bloqueio. A gravação atômica confirma o offset do Telegram e a operação no mesmo documento. Isso não é execução exatamente uma vez. Operação `em_execucao` de outro pid vira `resultado_incerto` e não é repetida. Falha de gravação desfaz a memória e não avança o offset.
- Sem id estável, a chave usa o id da aba na barra, e o título só entra quando esse id não existe. O título da janela muda com o arquivo aberto (`.env - mercado`, `Browser Tab - mercado`, `Mercado Demo - mercado`). Usar a janela inteira criou tópicos duplicados. A pasta é o último trecho antes de ` - Cursor`.
- Se já existe tópico com o mesmo nome, a ponte muda a chave no estado e não cria outro. O id do thread só sai do estado depois que o Telegram confirma a exclusão, ou quando o tópico já não existe.
- Cada tópico é gravado em `data/state.json` logo depois do `createForumTopic`. Antes a gravação vinha só no fim da leitura; com 20 conversas e as esperas de 429, um reinício no meio perdia os ids e a próxima rodada recriava tudo. O SIGTERM espera a última gravação.
- A procura por tópico com o mesmo nome fica restrita à mesma pasta. Janela sem lista de agentes (aba sintética) não ganha tópico, e nada sem tópico vai para o General.
- A leitura do Cursor e o `/recarregar` entram na mesma fila. Os dois ao mesmo tempo criavam um segundo tópico e esqueciam o id. O Bot API não lista tópicos; a limpeza desses ids perdidos foi manual.
- Pensamento do Cursor (`data-message-kind="thinking"`, texto “Thought” / “Thinking”) não é resposta. Ferramenta (`kind=tool`) também não. O papel `ai` sozinho não basta: o pensamento também vem com `data-message-role="ai"`.
- A lista `.agent-sidebar-list` tem altura zero. O nome real está em `.agent-sidebar-cell-text`. O clique que troca de conversa é na barra visível `.composite-bar-action-tab`, pelo título. Se `.auxiliary-bar-chat-title` já é essa conversa, não clica.
- Linhas de chrome ignoradas: New Agent, Search, Automations, Customize, More, rótulo `tertiary`, título que começa com `Draft:`.
- A janela “Cursor Agents” não tem essa lista. O tópico dela usa o nome da janela.
- Fila de envio de cerca de 350 ms. Callback tem prioridade sobre atualização de ícone. HTTP 429 espera `retry_after`. Erro 401, 403, 400, 5xx e rede são classificados. A resposta `message is not modified` não é erro. Long poll usa o timeout do Telegram mais 15 s. SIGINT e SIGTERM param a entrada, abortam o fetch, esperam até 8 s, marcam a operação em curso como incerta e soltam o bloqueio.
- O estado só vai para o disco quando o conteúdo muda. `lastCursorReadAt` sozinho não regrava. A cópia `.bak1` gira no máximo a cada 5 minutos. O temporário recebe `fsync` antes do `rename`, e o diretório também. `data/` fica em modo 700 e os arquivos em 600.
- O histórico local guarda até 40 mensagens por conversa. Conversas que não estão na tela nem num tópico aberto saem depois de 14 dias, e o que passar de 30 entradas perde as mais antigas. Tópico aberto e aba visível ficam.
- Seletores zerados ou inválidos em todas as janelas legíveis, por duas leituras seguidas, avisam no grupo. A leitura seguinte que encontrar a interface avisa que voltou.

## Como retomar

```bash
systemctl --user restart cursor-telegram.service
journalctl --user -u cursor-telegram.service -f
cd /home/luizdeangeli/Projetos/cursor-remote && node --test
```

Se a porta 9222 recusar conexão, o Cursor foi aberto pelo menu. Quit e `bin/cursor-debug`.

Uma atualização do Cursor quebra a leitura quando some `data-message-kind`, `.agent-sidebar-cell` ou `.composite-bar-action-tab`. O censo está em `node bin/probe.mjs`.

## Recuperação

Estado inválido não é substituído por estado vazio. Se existir `.bak1`–`.bak3` válido, a ponte continua dele e avisa o arquivo em quarentena. Versão futura do estado é recusada. Bloqueio de pid morto é recuperado. Bloqueio de pid vivo impede a segunda instância.

## Pendências

- Anexos e o acompanhamento de conversas fora da aba ativa ficam para depois desta base. Conversa atrás de More continua fora da leitura.
- A conversa completa só está no DOM da aba ativa. `/ultimo` numa aba inativa usa o histórico local daquela conversa e não mostra o texto de outra.
- Bolhas antigas de “Thought” que já foram para o grupo continuam lá. A ponte não guarda o id de cada uma para apagar.
- O computador precisa ficar ligado, com o Cursor na porta 9222.
- A base foi usada nesta máquina em 2026-11-11, com o serviço ativo, o Cursor na porta 9222 e o grupo no Telegram. Os testes cobrem a simulação dos fluxos. A versão está marcada como `v1.0.0`.
