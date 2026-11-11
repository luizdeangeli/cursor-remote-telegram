# Ponte Cursor para Telegram

Serviço local que lê as abas de agente do Cursor e deixa você acompanhar e responder pelo Telegram. Cada conversa vira um tópico do grupo. O que você escreve no tópico chega naquela aba. Enquanto o agente trabalha, uma mensagem de andamento é atualizada no lugar. A resposta final chega como mensagem nova. Pedido de aprovação chega com os botões **Aprovar** e **Recusar**.

Não tem tela de configuração. Roda na mesma máquina em que o Cursor está aberto.

## O que você precisa

- Node.js 22
- Cursor instalado nessa máquina
- Um bot criado no [@BotFather](https://t.me/BotFather) com `/newbot`
- Um grupo do Telegram com **Tópicos** ligados
- O bot como administrador desse grupo, com permissão de gerenciar tópicos

O computador precisa ficar ligado, com o Cursor aberto pela porta de depuração. A ponte não roda na nuvem.

## 1. Clonar e configurar

```bash
git clone https://github.com/luizdeangeli/cursor-remote-telegram.git
cd cursor-remote-telegram
cp .env.example .env
chmod 600 .env
```

Preencha no `.env`:

| Variável | O que colocar |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | O token que o BotFather mostrou. Não compartilhe. |
| `TELEGRAM_ALLOWED_USER_ID` | O seu id numérico. Se ficar vazio, a ponte trava no primeiro usuário que escrever no grupo. |
| `TELEGRAM_CHAT_ID` | O id do grupo. É negativo. Se ficar vazio, a ponte usa o primeiro grupo em que você escrever. |
| `CDP_URL` | Deixe `http://127.0.0.1:9222`, a menos que você tenha mudado a porta. |
| `POLL_INTERVAL_MS` | Intervalo de leitura do Cursor, em milissegundos. O padrão é `2000`. |

Para descobrir o seu id, mande `/start` para o [@userinfobot](https://t.me/userinfobot). O id do grupo aparece no `/status` depois da primeira mensagem sua.

## 2. Preparar o grupo

1. Crie um grupo e abra as configurações dele.
2. Ligue **Tópicos**.
3. Adicione o bot e promova a administrador.
4. Marque a permissão de gerenciar tópicos.

Sem tópicos, a ponte ainda funciona: use `/abas` para listar as conversas e `/usar N` para escolher uma. As mensagens seguintes, fora de um tópico, vão para a aba escolhida.

## 3. Abrir o Cursor na porta de depuração

O Cursor aberto pelo menu não escuta a porta 9222. Feche todas as janelas pelo menu (**Quit Cursor**, não basta fechar a janela) e abra de novo com:

```bash
./bin/cursor-debug
```

No Linux o script procura `/usr/share/cursor/cursor` e, se não achar, o `cursor` do `PATH`. Em outro sistema, abra o executável do Cursor com estes argumentos:

```bash
cursor --no-sandbox --remote-debugging-port=9222
```

Um segundo `cursor` enquanto já existe um processo principal imprime que o DevTools está escutando e sai. A porta morre junto. Se o script avisar que o Cursor já está aberto sem a porta, faça Quit e rode de novo.

Confira no navegador: [http://127.0.0.1:9222/json](http://127.0.0.1:9222/json) precisa mostrar uma lista.

## 4. Rodar

```bash
node src/bridge.mjs
```

Ou:

```bash
npm start
```

Escreva qualquer coisa no grupo, com a conta cujo id está em `TELEGRAM_ALLOWED_USER_ID`. Essa mensagem prende o chat. Em seguida mande `/recarregar` no tópico **General**. A ponte cria um tópico para cada conversa de agente aberta.

Para deixar no ar depois de sair do terminal, no Linux com systemd de usuário:

```bash
mkdir -p ~/.config/systemd/user
sed "s|@ROOT@|$(pwd)|g" systemd/cursor-telegram.service \
  > ~/.config/systemd/user/cursor-telegram.service
systemctl --user daemon-reload
systemctl --user enable --now cursor-telegram.service
systemctl --user status cursor-telegram.service
```

Se o `node` não estiver em `/usr/bin/node`, troque o `ExecStart` da unidade pelo caminho de `which node`.

Os logs ficam em:

```bash
journalctl --user -u cursor-telegram.service -f
```

Para o serviço subir no boot sem uma sessão gráfica aberta:

```bash
sudo loginctl enable-linger "$USER"
```

## Como usar

Cada aba de agente vira um tópico. O título é o nome da conversa. O **General** é só para comandos e para o menu de botões. Texto livre escrito no General não vira prompt.

1. Abra ou continue uma conversa de agente no Cursor.
2. No grupo, mande `/recarregar` no General quando aparecer uma aba nova ou quando fechar uma.
3. Entre no tópico dessa conversa e escreva o prompt.
4. A ponte responde **Enviado.** O Cursor passa a trabalhar nessa aba. Se ela estava em segundo plano, a ponte troca para ela antes de digitar.
5. Enquanto o agente trabalha, a mensagem **Trabalhando…** é editada no mesmo lugar. O ícone do tópico também muda.
6. Quando a resposta fica pronta, essa mensagem some e o texto final entra como mensagem nova.
7. Se o Cursor pedir permissão para um passo, chegam os botões **Aprovar** e **Recusar**.

Mensagem de qualquer outro usuário é ignorada.

### Comandos

| Comando | Onde | O que faz |
| --- | --- | --- |
| `/ajuda` | Qualquer tópico | Mostra este resumo e os botões |
| `/menu` | General | Mostra os botões de novo |
| `/abas` | Qualquer tópico | Lista as janelas e abas |
| `/usar N` | Quando o grupo não tem tópicos | Escolhe a aba número N da lista |
| `/status` | Qualquer tópico | Mostra o chat preso, se há tópicos e as janelas visíveis |
| `/ultimo N` | Tópico da aba | Reenvia as últimas mensagens. Sem N, manda 5. O máximo é 20 |
| `/tela` | Tópico da aba | Manda uma captura da janela |
| `/parar` | Tópico da aba | Interrompe o agente dessa aba |
| `/recarregar` | Só no General | Relê as abas, cria os tópicos novos e apaga os de abas fechadas |

Os botões do General repetem Abas, Recarregar, Status, Tela, Parar e Ajuda. Tela e Parar usam a aba ativa naquele momento.

`/start` e `/help` fazem o mesmo que `/ajuda`.

## Se a leitura quebrar

A ponte lê a tela do Cursor. Uma atualização do editor pode mudar os seletores em `selectors.json`. Para ver o que a porta está expondo:

```bash
npm run probe
```

Ou:

```bash
CDP_URL=http://127.0.0.1:9222 node bin/probe.mjs
```

Se [http://127.0.0.1:9222/json](http://127.0.0.1:9222/json) não abrir, o Cursor foi iniciado pelo menu. Faça Quit e abra com `./bin/cursor-debug`.

Os testes não precisam do Cursor nem do Telegram:

```bash
npm test
```

## Limites

- A conversa completa é a da aba ativa de cada janela. Mandar texto para o tópico de uma aba em segundo plano troca para ela.
- Conversa escondida atrás de **More** na barra lateral não entra na leitura.
- A porta 9222 dá controle do Cursor para programas desta máquina. Ela fica em `127.0.0.1`. Não publique essa porta na rede.
- O token do bot e o arquivo `.env` ficam só na sua máquina. O `.env` já está no `.gitignore`.
