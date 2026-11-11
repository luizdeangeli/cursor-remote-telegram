# Handoff — Ponte Cursor para Telegram

Atualizado em 2026-11-10. Serviço local, sem tela e sem dependência npm. Node 22. Código em inglês. Textos do Telegram e este arquivo em pt-BR.

Não é o Mercado. Não captura pagamento, não usa gateway e não lê o repositório `mercado` para autorizar nada.

## Onde está

| Peça | Caminho |
| --- | --- |
| Código | `/home/luizdeangeli/Projetos/cursor-remote` |
| Segredos | `.env` modo 600. Não commitar. Modelo em `.env.example` |
| Estado | `data/state.json` (gitignored): offset do polling, tópicos, hashes já enviados |
| Seletores do DOM | `selectors.json` |
| Serviço | `systemctl --user status cursor-telegram.service` |
| Unidade | `~/.config/systemd/user/cursor-telegram.service` |
| Abrir o Cursor na porta | `bin/cursor-debug` |
| Testes | `node --test` na pasta do projeto |

O Cursor precisa estar aberto com `--no-sandbox --remote-debugging-port=9222`. O atalho do menu não liga a porta. Um segundo `cursor` enquanto já existe um processo principal imprime “DevTools listening” e sai; a porta morre. Feche pelo Quit e abra de novo com `bin/cursor-debug`. Conferir em `http://127.0.0.1:9222/json`.

## O que faz

Long polling do Bot API. Um tópico do grupo por conversa de agente. O General (thread 1) só aceita comando. Texto livre num tópico vai para aquela conversa. Só o `TELEGRAM_ALLOWED_USER_ID` comanda. O `TELEGRAM_CHAT_ID` pode ficar vazio: a primeira mensagem sua no grupo trava o chat.

Comandos: `/abas`, `/usar N`, `/status`, `/ultimo N`, `/tela`, `/parar`, `/recarregar`, `/ajuda`. O `/recarregar` só no General: relê as conversas, reaproveita o tópico do mesmo nome, cria o que falta e apaga o de conversa fechada.

Enquanto o agente trabalha, uma mensagem “Trabalhando…” é editada. Quando a resposta fica pronta, essa mensagem é apagada e o texto final entra como mensagem nova. Aprovação chega com os botões Aprovar e Recusar.

## Decisões que não se desfazem sem motivo

- A chave do tópico é `pasta::nome da conversa`. O título da janela muda com o arquivo aberto (`.env - mercado`, `Browser Tab - mercado`, `Mercado Demo - mercado`). Usar esse título criou tópicos duplicados. A pasta é o último trecho antes de ` - Cursor`.
- Se já existe tópico com o mesmo nome, a ponte muda a chave no estado e não cria outro. O id do thread só sai do estado depois que o Telegram confirma a exclusão, ou quando o tópico já não existe.
- Cada tópico é gravado em `data/state.json` logo depois do `createForumTopic`. Antes a gravação vinha só no fim da leitura; com 20 conversas e as esperas de 429, um reinício no meio perdia os ids e a próxima rodada recriava tudo. O SIGTERM espera a última gravação.
- A procura por tópico com o mesmo nome fica restrita à mesma pasta. Janela sem lista de agentes (aba sintética) não ganha tópico, e nada sem tópico vai para o General.
- A leitura do Cursor e o `/recarregar` entram na mesma fila. Os dois ao mesmo tempo criavam um segundo tópico e esqueciam o id. O Bot API não lista tópicos; a limpeza desses ids perdidos foi manual.
- Pensamento do Cursor (`data-message-kind="thinking"`, texto “Thought” / “Thinking”) não é resposta. Ferramenta (`kind=tool`) também não. O papel `ai` sozinho não basta: o pensamento também vem com `data-message-role="ai"`.
- A lista `.agent-sidebar-list` tem altura zero. O nome real está em `.agent-sidebar-cell-text`. O clique que troca de conversa é na barra visível `.composite-bar-action-tab`, pelo título. Se `.auxiliary-bar-chat-title` já é essa conversa, não clica.
- Linhas de chrome ignoradas: New Agent, Search, Automations, Customize, More, rótulo `tertiary`, título que começa com `Draft:`.
- A janela “Cursor Agents” não tem essa lista. O tópico dela usa o nome da janela.
- Fila de envio de cerca de 350 ms. HTTP 429 espera `retry_after` até 3 vezes. `getChat` é reconsultado a cada 30 s enquanto `state.forum` não é verdadeiro. SIGTERM encerra o processo em 300 ms para o restart não ficar preso no long poll.

## Como retomar

```bash
systemctl --user restart cursor-telegram.service
journalctl --user -u cursor-telegram.service -f
cd /home/luizdeangeli/Projetos/cursor-remote && node --test
```

Se a porta 9222 recusar conexão, o Cursor foi aberto pelo menu. Quit e `bin/cursor-debug`.

Uma atualização do Cursor quebra a leitura quando some `data-message-kind`, `.agent-sidebar-cell` ou `.composite-bar-action-tab`. O censo está em `node bin/probe.mjs`.

## Pendências

- Bolhas antigas de “Thought” que já foram para o grupo continuam lá. A ponte não guarda o id de cada uma para apagar.
- Conversa escondida atrás de More na barra lateral não entra na leitura.
- A conversa completa só está no DOM da aba ativa. Mandar texto para um tópico em segundo plano troca para ela antes de digitar.
- O computador precisa ficar ligado, com o Cursor na porta 9222.
