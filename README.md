# Cursor remoto pelo Telegram

Serviço local que lê as abas de agente do Cursor e deixa você acompanhar e responder pelo Telegram. Cada conversa vira um tópico do grupo. O que você escreve no tópico chega naquela aba. Enquanto o agente trabalha, uma mensagem de andamento é atualizada no lugar. A resposta final chega como mensagem nova. Pedido de aprovação chega com os botões **Aprovar** e **Recusar**.

Não tem tela de configuração. Roda na mesma máquina em que o Cursor está aberto.

## O que você precisa

- Node.js 22
- Cursor instalado nessa máquina
- Um bot criado no [@BotFather](https://t.me/BotFather) com `/newbot`
- Um grupo do Telegram com **Tópicos** ligados
- O bot como administrador desse grupo, com permissão de gerenciar tópicos

O computador precisa ficar ligado, com o Cursor aberto pela porta de depuração. A ponte não roda na nuvem.

## 1. Preparar a máquina e configurar o bot

Os comandos abaixo usam Linux e Bash. Confira a versão com `node --version`. O projeto usa recursos nativos do Node.js e dispensa a etapa de instalar pacotes com npm.

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
| `TELEGRAM_ALLOWED_USER_ID` | O seu id numérico. Preencha antes de iniciar. Se ficar vazio, a primeira mensagem recebida pode definir o usuário autorizado. |
| `TELEGRAM_CHAT_ID` | O id do grupo. É negativo. Se ficar vazio, a primeira mensagem aceita define o chat, inclusive se vier de uma conversa privada. |
| `CDP_URL` | Deixe `http://127.0.0.1:9222`, a menos que você tenha mudado a porta. |
| `POLL_INTERVAL_MS` | Intervalo de leitura do Cursor, em milissegundos. O padrão é `2000`. |

Para descobrir o seu id, mande `/start` para o [@userinfobot](https://t.me/userinfobot). Se ainda não souber o ID do grupo, deixe apenas `TELEGRAM_CHAT_ID` em branco e faça o primeiro contato com o seu bot pelo General do grupo, como no passo 4.

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

## 4. Fazer o primeiro teste pelo celular

Abra um projeto no Cursor e deixe uma conversa de agente visível na barra lateral. Em outro terminal, na pasta do repositório, inicie a ponte.

```bash
node src/bridge.mjs
```

Ou:

```bash
npm start
```

1. No **General** do grupo, envie `/status` com a conta configurada. Confira o ID em **Chat**, **Tópicos: sim** e pelo menos uma janela visível. Se deixou o ID do grupo em branco, copie o número completo, incluindo o sinal de menos, para `TELEGRAM_CHAT_ID` no arquivo `.env`. Reinicie a ponte para aplicar a edição.
2. Ainda no General, envie `/abas` e confira o nome da conversa aberta. Envie `/recarregar` para sincronizar os tópicos. Ao fechar uma aba, esse comando também pode apagar o tópico correspondente e seu histórico no Telegram.
3. Abra o tópico com o nome da conversa e envie **Responda apenas com “Ponte funcionando”.**
4. Confira **Enviado.** no Telegram, o mesmo prompt na aba do Cursor e a resposta final no tópico. A confirmação de envio aparece antes da resposta do agente.

## 5. Manter a ponte em execução no Linux

Encerre a execução manual com `Ctrl+C` antes de iniciar o serviço. Confira `command -v node`. Se o caminho for diferente de `/usr/bin/node`, ajuste a linha `ExecStart` na unidade gerada antes de executar `daemon-reload`.

Para deixar no ar depois de sair do terminal, no Linux com systemd de usuário:

```bash
mkdir -p ~/.config/systemd/user
sed "s|@ROOT@|$(pwd)|g" systemd/cursor-telegram.service \
  > ~/.config/systemd/user/cursor-telegram.service
```

Depois de conferir o caminho do Node na unidade, ative o serviço.

```bash
systemctl --user daemon-reload
systemctl --user enable --now cursor-telegram.service
systemctl --user status cursor-telegram.service
```

Após editar o `.env`, aplique as mudanças com `systemctl --user restart cursor-telegram.service`.

Os logs ficam em:

```bash
journalctl --user -u cursor-telegram.service -f
```

Opcionalmente, habilite o início do serviço de usuário no boot. Para interagir com o agente, o Cursor ainda precisa estar aberto em uma sessão gráfica com a porta de depuração ativa.

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

## Diagnóstico por sintoma

| O que você observa | O que verificar |
| --- | --- |
| O bot ignora `/status` | Confira se a ponte está rodando, se o token pertence ao bot adicionado e se os IDs correspondem à conta e ao grupo que enviaram o comando. |
| O bot responde, mas mostra zero janelas | Abra a lista local em `http://127.0.0.1:9222/json`. Se a conexão falhar, encerre o Cursor pelo menu e repita o passo 3. |
| A janela aparece e falta uma conversa | Deixe a aba visível fora de **More**, envie `/abas` e depois `/recarregar` no General. |
| A aba aparece, mas o tópico não é criado | Confira **Tópicos: sim** em `/status` e a permissão **Gerenciar tópicos** do bot. |
| A ponte funciona no terminal, mas falha como serviço | Confira `WorkingDirectory` e `ExecStart` com `systemctl --user cat cursor-telegram.service` e consulte o log do passo 5. |

### Diagnosticar mudanças na interface do Cursor

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
