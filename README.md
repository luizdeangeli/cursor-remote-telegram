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
| `TELEGRAM_ALLOWED_USER_ID` | O seu id numérico. Se ficar vazio, a ponte imprime um código e só `/parear CODIGO` autoriza a conta. |
| `TELEGRAM_CHAT_ID` | O id do grupo. É negativo. Se ficar vazio, o mesmo `/parear CODIGO` no grupo autoriza o chat. |
| `CDP_URL` | Deixe `http://127.0.0.1:9222`, a menos que você tenha mudado a porta. |
| `POLL_INTERVAL_MS` | Intervalo de leitura do Cursor, em milissegundos. O padrão é `2000`. |
| `COMPARTILHAR` | `todas` cria um tópico para cada conversa visível. `escolhidas` só cria depois de **Incluir** em **Projetos**. O padrão é `todas`. |

Para descobrir o seu id, mande `/start` para o [@userinfobot](https://t.me/userinfobot). Se o usuário ou o grupo ficarem em branco, a ponte não aceita o primeiro remetente. Ela imprime `Pareamento pendente. No grupo, envie /parear CODIGO`. Envie esse comando no General com a sua conta.

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

No Linux o script procura `/usr/share/cursor/cursor` e, se não achar, o `cursor` do `PATH`. Ele só acrescenta `--no-sandbox` quando `chrome-sandbox` não tem o bit setuid. Em outro sistema, abra o executável do Cursor com este argumento:

```bash
cursor --remote-debugging-port=9222
```

Se o Cursor recusar a subir porque o sandbox não está configurado, repita o comando com `--no-sandbox`.

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

1. Se o terminal pediu pareamento, envie `/parear CODIGO` no **General**. Depois envie `/status`. Confira **Tópicos: sim** e pelo menos uma janela visível.
2. Ainda no General, envie `/abas` e `/recarregar`. No modo `todas`, uma conversa fechada fica marcada como fechada e o histórico do tópico permanece. No modo `escolhidas`, `/recarregar` apaga os tópicos e a seleção para você incluir de novo.
3. Abra o tópico da conversa e envie **Responda apenas com “Ponte funcionando”.**
4. A ponte responde **Recebido pela ponte. Aguardando envio.** e, depois de ver a mensagem na conversa certa, **Recebido pelo Cursor.** A resposta final entra no tópico em seguida.

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
4. A ponte responde **Recebido pela ponte. Aguardando envio.** e depois **Recebido pelo Cursor.** Se a conversa estava em segundo plano, a ponte troca para ela e confirma o título antes de digitar. Um rascunho já presente no campo impede o envio.
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
| `/projetos` | General | Lista os projetos e, no modo escolhidas, os botões Incluir e Ocultar |
| `/ocultar` | Tópico da aba | Deixa de espelhar essa conversa quando `COMPARTILHAR=escolhidas` |
| `/usar N` | Quando o grupo não tem tópicos | Escolhe a aba número N da lista |
| `/status` | Qualquer tópico | Mostra o chat pareado, se há tópicos e as janelas visíveis |
| `/diagnostico` | Qualquer tópico | Mostra a causa da falha e o próximo passo, sem o token |
| `/ultimo N` | Tópico da aba | Reenvia o histórico desta conversa. Sem N, manda 5. O máximo é 20. Aba inativa usa só o que foi visto nela |
| `/limpar` | Tópico da aba | Apaga o histórico local desta conversa. As mensagens do Telegram ficam |
| `/tela` | Tópico da aba, ou General | Captura a conversa do tópico. No General, captura a janela atual e diz isso |
| `/parar` | Tópico da aba, ou General | Interrompe o agente dessa conversa. No General, interrompe a janela atual |
| `/esquecer` | Tópico da aba | Pede confirmação e só então apaga o tópico e o histórico no Telegram |
| `/parear CODIGO` | General | Autoriza a conta e o grupo com o código impresso no terminal |
| `/recarregar` | Só no General | No modo `todas`, marca conversas fechadas e mantém o histórico. No modo `escolhidas`, apaga os tópicos e a seleção |

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

Se o Telegram não responde, o diagnóstico local não precisa do grupo:

```bash
npm run diagnostico
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

- A conversa completa é a da aba ativa de cada janela. Mandar texto para o tópico de uma aba em segundo plano troca para ela e só confirma o envio depois de ver o texto nessa conversa.
- Um resultado incerto não é reenviado sozinho. A ponte avisa e espera um pedido novo.
- Resposta longa não é cortada em silêncio. Se o Cursor só mostrou parte do texto, a mensagem diz isso.
- Anexos e o acompanhamento de conversas que não estão na aba ativa ficam para uma etapa seguinte.
- Conversa escondida atrás de **More** na barra lateral não entra na leitura.
- A porta 9222 dá controle do Cursor para programas desta máquina. Ela fica em `127.0.0.1`. Não publique essa porta na rede.
- O token do bot e o arquivo `.env` ficam só na sua máquina. O `.env` já está no `.gitignore`.
