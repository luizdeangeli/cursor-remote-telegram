import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Bridge } from "../src/bridge.mjs";
import { shortId } from "../src/delivery.mjs";
import { emptyState } from "../src/state.mjs";
import { Telegram } from "../src/telegram.mjs";

function windowOf(patch = {}) {
  return {
    targetId: "w1",
    title: "mercado - Cursor",
    status: "idle",
    activity: "",
    tabs: [
      { id: "a", title: "Auditoria", active: true, index: 0 },
      { id: "b", title: "Perfil", active: false, index: 1 },
    ],
    messages: [],
    approvals: [],
    ...patch,
  };
}

class FakeCursor {
  constructor(data) {
    this.data = data;
    this.prompts = [];
    this.clicks = [];
    this.composer = "";
    this.focusedTitle = data[0]?.tabs?.find((tab) => tab.active)?.title || "";
  }

  async windows() {
    if (this.fail) throw new Error("conexão recusada");
    return this.data;
  }

  async prepareConversation(targetId, title) {
    if (this.failFocus) throw Object.assign(new Error(this.failFocus), { beforeEffect: true });
    const window = this.data.find((item) => item.targetId === targetId);
    const tab = window?.tabs?.find((item) => item.title === title);
    if (!tab) throw Object.assign(new Error("Aba não encontrada"), { beforeEffect: true });
    this.focusedTitle = title;
    for (const item of window.tabs) item.active = item.title === title;
    return { title };
  }

  async readSurface(targetId) {
    const window = this.data.find((item) => item.targetId === targetId) || this.data[0];
    return {
      title: this.focusedTitle,
      activeTab: this.focusedTitle,
      composer: this.composer,
      approvals: window?.approvals || [],
      messages: window?.messages || [],
    };
  }

  async submitPrompt(targetId, text) {
    if (String(this.composer || "").trim()) {
      throw Object.assign(new Error("Há um rascunho nesta conversa."), { beforeEffect: true, draft: true });
    }
    this.prompts.push({ targetId, text, title: this.focusedTitle });
    const window = this.data.find((item) => item.targetId === targetId) || this.data[0];
    window.messages = [...(window.messages || []), { id: `h${this.prompts.length}`, role: "human", text }];
  }

  async observePrompt(targetId, text) {
    if (this.forceUncertain) return { ok: false, title: this.focusedTitle };
    const window = this.data.find((item) => item.targetId === targetId) || this.data[0];
    const found = (window.messages || []).some((message) => message.role === "human" && message.text === text);
    return { ok: found, title: this.focusedTitle };
  }

  async clickKind(targetId, kind, index) {
    this.clicks.push({ targetId, kind, index });
  }

  async screenshot() {
    return Buffer.from("png");
  }

  close() {}
}

class FakeTelegram {
  constructor() {
    this.sent = [];
    this.edits = [];
    this.nextThread = 20;
    this.nextMessage = 1;
  }

  async createForumTopic(_chatId, name) {
    return { message_thread_id: this.nextThread++, name };
  }

  async editForumTopic(_chatId, threadId, name) {
    this.renames = this.renames || [];
    this.renames.push({ threadId, name });
  }

  async setForumTopicIcon(_chatId, threadId, emojiId) {
    this.icons = this.icons || [];
    this.icons.push({ threadId, emojiId });
  }

  async sendDocument(chatId, text, extra = {}) {
    const message = { message_id: this.nextMessage++, chatId, document: text, ...extra };
    this.sent.push(message);
    return message;
  }

  async deleteForumTopic(_chatId, threadId) {
    this.deletedTopics = this.deletedTopics || [];
    this.deletedTopics.push(threadId);
  }

  async sendText(chatId, text, extra = {}) {
    const message = { message_id: this.nextMessage++, chatId, text, ...extra };
    this.sent.push(message);
    return message;
  }

  async deleteMessage(_chatId, messageId) {
    this.edits.push({ messageId, deleted: true });
  }

  async editText(_chatId, messageId, text) {
    this.edits.push({ messageId, text });
    return { message_id: messageId, text };
  }

  async sendPhoto(chatId, png, extra = {}) {
    this.sent.push({ chatId, photo: png, ...extra });
  }

  async editMessage(chatId, messageId, text, replyMarkup) {
    this.markups = this.markups || [];
    this.markups.push({ chatId, messageId, text, replyMarkup });
  }

  async editMarkup(chatId, messageId, replyMarkup) {
    this.markups = this.markups || [];
    this.markups.push({ chatId, messageId, replyMarkup });
  }

  async answerCallback(id, text) {
    this.sent.push({ callback: id, text });
  }

  async getChat() {
    return { is_forum: true };
  }

  async getMe() {
    return { id: 7, username: "ponte" };
  }

  async getChatMember() {
    return { status: "administrator", can_manage_topics: true };
  }
}

function bridgeFor(cursor, telegram, state = emptyState()) {
  state.chatId = "-1001";
  state.allowedUserId = "42";
  return new Bridge({
    config: { chatId: "-1001", allowedUserId: "42", pollIntervalMs: 10 },
    state,
    telegram,
    cursor,
    save: async () => {},
  });
}

test("cria um tópico por aba e manda o prompt de volta para a aba certa", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  assert.equal(Object.keys(bridge.state.topics).length, 2);

  const auditoria = bridge.state.topics["mercado::a"];
  await bridge.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      message_thread_id: auditoria.threadId,
      text: "revisa o login",
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  assert.deepEqual(cursor.prompts, [{ targetId: "w1", text: "revisa o login", title: "Auditoria" }]);
  assert.equal(telegram.sent.at(-1).text, "Recebido pelo Cursor.");
  assert.ok(telegram.sent.some((message) => message.text === "Recebido pela ponte. Aguardando envio."));
});

test("mostra o andamento, a resposta final e não repete depois de reiniciar", async () => {
  const cursor = new FakeCursor([windowOf({
    status: "running",
    activity: "Editando login",
    messages: [{ id: "m1", role: "assistant", text: "vou olhar o login" }],
  })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  assert.equal(telegram.edits.length, 0);
  assert.match(telegram.sent.at(-1).text, /Editando login/);
  const threadId = bridge.state.topics["mercado::a"].threadId;
  const iconOf = () => telegram.icons.filter((icon) => icon.threadId === threadId).at(-1).emojiId;
  assert.equal(iconOf(), "5312016608254762256");

  cursor.data[0].status = "idle";
  cursor.data[0].activity = "";
  cursor.data[0].messages = [{ id: "m1", role: "assistant", text: "login revisado" }];
  await bridge.syncOnce();
  assert.equal(iconOf(), "5417915203100613993");
  const hidden = bridge.state.topics["mercado::b"].threadId;
  assert.equal(telegram.icons.filter((icon) => icon.threadId === hidden).at(-1).emojiId, "");
  assert.ok(telegram.sent.some((message) => message.text === "login revisado"));
  const finalCount = telegram.sent.filter((message) => message.text === "login revisado").length;

  const restarted = bridgeFor(cursor, telegram, structuredClone(bridge.state));
  await restarted.syncOnce();
  const after = telegram.sent.filter((message) => message.text === "login revisado").length;
  assert.equal(after, finalCount);
});

test("grava cada tópico assim que ele é criado", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const saved = [];
  const bridge = bridgeFor(cursor, telegram);
  bridge.save = async (payload) => { saved.push(Object.keys(payload.topics).length); };
  const send = telegram.sendText.bind(telegram);
  telegram.sendText = async (...args) => {
    if (String(args[1]).startsWith("Aba ligada")) throw new Error("processo encerrado");
    return send(...args);
  };
  await bridge.syncOnce();
  assert.ok(saved.includes(1));
  assert.ok(saved.includes(2));
});

test("dois sync ao mesmo tempo criam um tópico só", async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const cursor = new FakeCursor([windowOf({
    tabs: [{ id: "perfil", title: "perfil", active: true, index: 0 }],
  })]);
  const windows = cursor.windows.bind(cursor);
  let calls = 0;
  cursor.windows = async () => {
    calls += 1;
    if (calls === 1) await gate;
    return windows();
  };
  const telegram = new FakeTelegram();
  const create = telegram.createForumTopic.bind(telegram);
  let created = 0;
  telegram.createForumTopic = async (...args) => {
    created += 1;
    return create(...args);
  };
  const bridge = bridgeFor(cursor, telegram);
  const first = bridge.syncOnce();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = bridge.syncOnce();
  open();
  await Promise.all([first, second]);
  assert.equal(created, 1);
  assert.equal(Object.keys(bridge.state.topics).length, 1);
});

test("renomeia o tópico antigo para incluir o projeto", async () => {
  const cursor = new FakeCursor([windowOf({
    tabs: [{ id: "perfil", title: "perfil", active: true, index: 0 }],
  })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  bridge.state.forum = true;
  bridge.state.topics["mercado::perfil"] = { threadId: 20, title: "perfil", targetId: "w1" };
  await bridge.syncOnce();
  assert.equal(bridge.state.topics["mercado::perfil"].title, "mercado · perfil");
  assert.deepEqual(telegram.renames, [{ threadId: 20, name: "mercado · perfil" }]);
});

test("não duplica o tópico quando só o arquivo da janela muda", async () => {
  const cursor = new FakeCursor([windowOf({
    title: ".env - mercado - Cursor",
    tabs: [{ id: "perfil", title: "perfil", active: true, index: 0 }],
  })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  cursor.data[0].title = "Mercado Demo - mercado - Cursor";
  await bridge.syncOnce();
  assert.equal(Object.keys(bridge.state.topics).length, 1);
  assert.equal(bridge.state.topics["mercado::perfil"].threadId, 20);
  assert.equal(telegram.sent.filter((message) => message.text.includes("Aba ligada")).length, 1);
});

test("tela no General pede para usar o tópico", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  bridge.state.forum = true;
  bridge.windows = cursor.data;
  await bridge.handleUpdate({
    update_id: 11,
    message: {
      message_id: 4,
      message_thread_id: 1,
      text: "/tela",
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  assert.match(telegram.sent.at(-1).text, /Use \/tela dentro do tópico/);
  assert.equal(telegram.sent.some((message) => message.photo), false);
});

test("o botão de tela no General pede para usar o tópico", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  bridge.windows = cursor.data;
  await bridge.handleUpdate({
    update_id: 12,
    callback_query: {
      id: "cbtela",
      data: "m:tela",
      from: { id: 42 },
      message: { message_thread_id: 1, chat: { id: -1001 } },
    },
  });
  assert.match(telegram.sent.at(-1).text, /Use \/tela dentro do tópico/);
  assert.equal(telegram.sent.some((message) => message.photo), false);
});

test("tela num tópico manda a foto para esse thread", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const threadId = bridge.state.topics["mercado::a"].threadId;
  await bridge.handleUpdate({
    update_id: 13,
    message: {
      message_id: 5,
      message_thread_id: threadId,
      text: "/tela",
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  const photo = telegram.sent.find((message) => message.photo);
  assert.equal(photo.message_thread_id, threadId);
  assert.equal(photo.caption, "mercado · Auditoria");
});

test("no modo escolhidas só a conversa incluída ganha tópico", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  bridge.config.shareMode = "escolhidas";
  await bridge.syncOnce();
  assert.equal(Object.keys(bridge.state.topics).length, 0);

  await bridge.handleUpdate({
    update_id: 30,
    callback_query: {
      id: "inc",
      data: `i:${shortId("mercado::a")}`,
      from: { id: 42 },
      message: { message_thread_id: 1, chat: { id: -1001 } },
    },
  });
  assert.equal(Object.keys(bridge.state.topics).length, 1);
  assert.equal(bridge.state.shared["mercado::a"], true);
  const row = telegram.sent.at(-1).reply_markup.inline_keyboard.find((buttons) => buttons.some((button) => button.url));
  assert.equal(row[0].text, "Auditoria");
  assert.equal(row[1].callback_data, `o:${shortId("mercado::a")}`);
  assert.equal(telegram.sent.at(-1).reply_markup.inline_keyboard.some((buttons) => buttons[0].text === "Incluir Perfil"), true);

  await bridge.syncOnce();
  assert.equal(Object.keys(bridge.state.topics).length, 1);

  await bridge.handleUpdate({
    update_id: 31,
    message: {
      message_id: 9,
      message_thread_id: bridge.state.topics["mercado::a"].threadId,
      text: "/ocultar",
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  assert.equal(bridge.state.topics["mercado::a"], undefined);
  assert.equal(bridge.state.shared["mercado::a"], undefined);
  assert.match(telegram.sent.at(-1).text, /Oculta: mercado · Auditoria/);
});

test("recarregar no modo escolhidas apaga os tópicos e a seleção", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  bridge.config.shareMode = "escolhidas";
  bridge.state.forum = true;
  bridge.windows = cursor.data;
  bridge.state.topics = {
    "mercado::a": { threadId: 20, title: "mercado · Auditoria", targetId: "w1" },
    "sig::8557": { threadId: 30, title: "sig · 8557", targetId: "w2" },
  };
  bridge.state.shared = { "mercado::a": true, "sig::8557": true };
  bridge.state.sent = { "mercado::a": ["h"] };
  await bridge.handleUpdate({
    update_id: 32,
    message: {
      message_id: 10,
      message_thread_id: 1,
      text: "/recarregar",
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  assert.equal(bridge.state.topics["mercado::a"].threadId, 20);
  assert.match(telegram.sent.at(-1).text, /apaga os tópicos/);
  assert.equal(telegram.sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data, "c:limpar");
  await bridge.handleUpdate({
    update_id: 33,
    callback_query: {
      id: "cblimpar",
      data: "c:limpar",
      from: { id: 42 },
      message: { message_thread_id: 1, chat: { id: -1001 } },
    },
  });
  assert.deepEqual(bridge.state.topics, {});
  assert.deepEqual(bridge.state.shared, {});
  assert.deepEqual(bridge.state.sent, {});
  assert.deepEqual([...telegram.deletedTopics].sort(), [20, 30]);
  assert.match(telegram.sent.at(-1).text, /Conversas limpas \(2\)/);
  assert.equal(telegram.sent.some((message) => String(message.text || "").includes("Aba ligada")), false);
});

test("abas agrupa por projeto e liga cada tópico", async () => {
  const cursor = new FakeCursor([
    windowOf(),
    windowOf({
      targetId: "w2",
      title: "sig - Cursor",
      tabs: [{ id: "8557", title: "8557", active: true, index: 0 }],
    }),
  ]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  bridge.state.forum = true;
  bridge.windows = cursor.data;
  bridge.state.topics = {
    "mercado::a": { threadId: 20, title: "mercado · Auditoria", targetId: "w1" },
    "mercado::b": { threadId: 21, title: "mercado · Perfil", targetId: "w1" },
    "sig::8557": { threadId: 30, title: "sig · 8557", targetId: "w2" },
  };
  await bridge.handleUpdate({
    update_id: 40,
    message: {
      message_id: 11,
      message_thread_id: 1,
      text: "/abas",
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  const groups = telegram.sent.filter((message) => message.reply_markup && (message.text === "mercado" || message.text === "sig"));
  assert.deepEqual(groups.map((message) => message.text), ["mercado", "sig"]);
  const mercado = groups[0].reply_markup.inline_keyboard;
  assert.equal(mercado[0][0].text, "Auditoria · ativa");
  assert.equal(mercado[0][0].url, "https://t.me/c/1/20");
  assert.equal(mercado[1][0].text, "Perfil · sem leitura");
  assert.equal(mercado[1][0].url, "https://t.me/c/1/21");
  assert.equal(groups[1].reply_markup.inline_keyboard[0][0].url, "https://t.me/c/1/30");
});

test("projetos lista as janelas e o toque abre o tópico", async () => {
  const cursor = new FakeCursor([
    windowOf(),
    windowOf({
      targetId: "w2",
      title: "sig - Cursor",
      tabs: [{ id: "8557", title: "8557", active: true, index: 0 }],
    }),
  ]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  bridge.state.forum = true;
  bridge.windows = cursor.data;
  bridge.state.topics = {
    "mercado::a": { threadId: 20, title: "mercado · Auditoria", targetId: "w1" },
    "mercado::b": { threadId: 21, title: "mercado · Perfil", targetId: "w1" },
    "sig::8557": { threadId: 30, title: "sig · 8557", targetId: "w2" },
  };
  await bridge.handleUpdate({
    update_id: 20,
    message: {
      message_id: 8,
      message_thread_id: 1,
      text: "/projetos",
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  const projects = telegram.sent.at(-1).reply_markup.inline_keyboard.flat().map((button) => button.text);
  assert.deepEqual(projects, ["mercado", "sig", "Menu"]);

  await bridge.handleUpdate({
    update_id: 21,
    callback_query: {
      id: "cbp",
      data: "g:0:mercado",
      from: { id: 42 },
      message: { message_thread_id: 1, chat: { id: -1001 } },
    },
  });
  const topics = telegram.sent.at(-1).reply_markup.inline_keyboard;
  assert.equal(topics[0][0].text, "Auditoria");
  assert.equal(topics[0][0].url, "https://t.me/c/1/20");
  assert.equal(topics[1][0].text, "Perfil · sem leitura");
  assert.equal(topics[1][0].url, "https://t.me/c/1/21");
  assert.equal(topics.at(-1).some((button) => button.callback_data === "m:projetos"), true);
});

test("a lista de tópicos passa para a página seguinte", async () => {
  const cursor = new FakeCursor([windowOf({
    tabs: [{ id: "a", title: "a", active: true, index: 0 }],
  })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  bridge.windows = cursor.data;
  bridge.state.topics = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [
    `mercado::${index}`,
    { threadId: 40 + index, title: `mercado · ${index}`, targetId: "w1" },
  ]));
  await bridge.handleUpdate({
    update_id: 22,
    callback_query: {
      id: "cbpage",
      data: "g:0:mercado",
      from: { id: 42 },
      message: { message_thread_id: 1, chat: { id: -1001 } },
    },
  });
  const first = telegram.sent.at(-1);
  assert.match(first.text, /Página 1 de 2/);
  assert.equal(first.reply_markup.inline_keyboard.filter((row) => row[0].url).length, 8);
  const next = first.reply_markup.inline_keyboard.at(-1).find((button) => button.text === "Próxima");
  await bridge.handleUpdate({
    update_id: 23,
    callback_query: {
      id: "cbpage2",
      data: next.callback_data,
      from: { id: 42 },
      message: { message_thread_id: 1, chat: { id: -1001 } },
    },
  });
  const second = telegram.sent.at(-1);
  assert.match(second.text, /Página 2 de 2/);
  assert.equal(second.reply_markup.inline_keyboard.filter((row) => row[0].url).length, 1);
});

test("atualiza os botões do menu já fixado", async () => {
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(new FakeCursor([]), telegram);
  bridge.state.forum = true;
  bridge.state.menuMessageId = 540;
  await bridge.ensureMenu();
  assert.equal(telegram.markups[0].messageId, 540);
  assert.equal(telegram.markups[0].replyMarkup.inline_keyboard[0][0].text, "Projetos");
  assert.equal(telegram.markups[0].replyMarkup.inline_keyboard[1][0].text, "Ativas");
  assert.deepEqual(
    telegram.markups[0].replyMarkup.inline_keyboard.flat().map((button) => button.callback_data),
    ["m:projetos", "m:ativas", "m:abas", "m:status", "m:diagnostico", "m:recarregar", "m:ajuda", "m:tela", "m:parar", "m:ultimo", "m:limpar", "m:ocultar", "m:esquecer"],
  );
  assert.match(telegram.markups[0].text, /Todas/);
  telegram.markups = [];
  await bridge.ensureMenu();
  assert.equal(telegram.markups.length, 0);
});

test("o comando /menu publica o teclado de novo no fim do General", async () => {
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(new FakeCursor([]), telegram);
  bridge.state.forum = true;
  bridge.state.menuMessageId = 540;
  bridge.state.menuVersion = 5;
  await bridge.handleUpdate({
    update_id: 81,
    message: {
      message_id: 12,
      message_thread_id: 1,
      text: "/menu",
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  assert.equal(telegram.edits.some((edit) => edit.deleted && edit.messageId === 540), true);
  const menu = telegram.sent.at(-1);
  assert.equal(menu.message_thread_id, 1);
  assert.equal(menu.reply_markup.inline_keyboard[0][0].callback_data, "m:projetos");
  assert.equal(bridge.state.menuMessageId, menu.message_id);
});

test("o botão do menu no General executa o comando", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  bridge.state.forum = true;
  await bridge.handleUpdate({
    update_id: 8,
    callback_query: {
      id: "cbm",
      data: "m:status",
      from: { id: 42 },
      message: { message_thread_id: 1, chat: { id: -1001 } },
    },
  });
  assert.match(telegram.sent.at(-1).text, /Janelas visíveis/);
  assert.equal(telegram.sent.at(-1).message_thread_id, 1);
});

test("recarregar no General atualiza os tópicos", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  bridge.state.topics["velha::x"] = { threadId: 99, title: "Velha", targetId: "w9" };
  await bridge.handleUpdate({
    update_id: 9,
    message: {
      message_id: 3,
      message_thread_id: 1,
      text: "/recarregar",
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  assert.equal(bridge.state.topics["velha::x"].closed, true);
  assert.equal(telegram.deletedTopics, undefined);
  assert.match(telegram.sent.at(-1).text, /Abas recarregadas \(2\)/);
  assert.match(telegram.sent.at(-1).text, /histórico dos tópicos foi mantido/);
  assert.equal(telegram.sent.at(-1).message_thread_id, 1);
});

function callback(id, data, { user = 42, chat = -1001, threadId = 0 } = {}) {
  return {
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      data,
      from: { id: user },
      message: { chat: { id: chat }, message_thread_id: threadId },
    },
  };
}

test("aprova uma vez, ignora outro usuário, outro chat e o segundo clique", async () => {
  const cursor = new FakeCursor([windowOf({
    status: "waiting_approval",
    activity: "Aguardando aprovação",
    approvals: [{ index: 0, label: "Run", command: "npm test" }],
  })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const ask = telegram.sent.find((message) => message.text.includes("npm test"));
  assert.match(ask.text, /Projeto: mercado/);
  assert.match(ask.text, /Conversa: Auditoria/);
  assert.equal(ask.reply_markup.inline_keyboard[0][0].text, "Aprovar");
  const data = ask.reply_markup.inline_keyboard[0][0].callback_data;
  const threadId = ask.message_thread_id;

  await bridge.handleUpdate(callback(2, data, { user: 99, threadId }));
  await bridge.handleUpdate(callback(3, data, { chat: -2000, threadId }));
  assert.equal(cursor.clicks.length, 0);

  await bridge.handleUpdate(callback(4, data, { threadId }));
  assert.equal(cursor.clicks.length, 1);
  assert.equal(cursor.clicks[0].kind, "approve");

  await bridge.handleUpdate(callback(5, data, { threadId }));
  assert.equal(cursor.clicks.length, 1);
});

test("o cliente fala com a API do Telegram", async () => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ url: request.url, body: JSON.parse(body || "{}") });
      const method = request.url.split("/").pop();
      const result = method === "getUpdates"
        ? [{ update_id: 7, message: { text: "oi" } }]
        : { message_id: 3, text: seen.at(-1).body.text };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const telegram = new Telegram("token", `http://127.0.0.1:${port}`);
    const sent = await telegram.sendText(1, "olá");
    const updates = await telegram.getUpdates(0, 0);
    assert.equal(sent.text, "olá");
    assert.equal(updates[0].update_id, 7);
    assert.match(seen[0].url, /\/bottoken\/sendMessage$/);
  } finally {
    server.close();
  }
});

function textUpdate(id, threadId, text) {
  return {
    update_id: id,
    message: {
      message_id: id,
      message_thread_id: threadId,
      text,
      from: { id: 42 },
      chat: { id: -1001 },
    },
  };
}

test("tópico desconhecido não mexe em nenhuma conversa", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  await bridge.handleUpdate(textUpdate(40, 999, "não manda"));
  assert.equal(cursor.prompts.length, 0);
  assert.equal(cursor.clicks.length, 0);
  assert.match(telegram.sent.at(-1).text, /recarregar/);
});

test("parar no tópico B atua em B e falha sem clique se não confirmar", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const threadB = bridge.state.topics["mercado::b"].threadId;
  await bridge.handleUpdate(textUpdate(41, threadB, "/parar"));
  assert.equal(cursor.focusedTitle, "Perfil");
  assert.equal(cursor.clicks.length, 1);
  assert.equal(cursor.clicks[0].kind, "stop");
  assert.match(telegram.sent.at(-1).text, /Perfil/);

  cursor.failFocus = "Não confirmei a conversa \"Perfil\". A janela está em \"Auditoria\".";
  cursor.clicks = [];
  await bridge.handleUpdate(textUpdate(42, threadB, "/parar"));
  assert.equal(cursor.clicks.length, 0);
  assert.match(telegram.sent.at(-1).text, /Não confirmei a conversa/);
});

test("rascunho local bloqueia o envio e permanece no campo", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  cursor.composer = "rascunho local";
  const threadId = bridge.state.topics["mercado::a"].threadId;
  await bridge.handleUpdate(textUpdate(43, threadId, "prompt remoto"));
  assert.equal(cursor.prompts.length, 0);
  assert.equal(cursor.composer, "rascunho local");
  assert.match(telegram.sent.at(-1).text, /rascunho/);
});

test("botão antigo não aprova um pedido novo com o mesmo texto", async () => {
  const cursor = new FakeCursor([windowOf({
    status: "waiting_approval",
    approvals: [{ index: 0, label: "Run", command: "npm test" }],
  })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const ask = telegram.sent.find((message) => message.text.includes("npm test"));
  const oldData = ask.reply_markup.inline_keyboard[0][0].callback_data;
  const threadId = ask.message_thread_id;
  cursor.data[0].approvals = [];
  await bridge.syncOnce();
  cursor.data[0].approvals = [{ index: 0, label: "Run", command: "npm test" }];
  await bridge.syncOnce();
  const fresh = telegram.sent.filter((message) => message.text?.includes("npm test")).at(-1);
  await bridge.handleUpdate(callback(44, oldData, { threadId }));
  assert.equal(cursor.clicks.length, 0);
  await bridge.handleUpdate(callback(45, fresh.reply_markup.inline_keyboard[0][0].callback_data, { threadId }));
  assert.equal(cursor.clicks.length, 1);
});

test("aprovação da conversa B não clica no pedido visível de A", async () => {
  const cursor = new FakeCursor([windowOf({
    approvals: [{ index: 0, label: "Run", command: "rm -rf /" }],
  })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const threadB = bridge.state.topics["mercado::b"].threadId;
  const token = {
    id: "bbbbbbbbbb",
    key: "mercado::b",
    hash: "diferente",
    index: 0,
    command: "npm test",
    label: "Run",
    threadId: threadB,
    chatId: "-1001",
    project: "mercado",
    conversation: "Perfil",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: "pending",
    ownerPid: 0,
  };
  bridge.state.approvalTokens[token.id] = token;
  await bridge.handleUpdate(callback(46, "a:bbbbbbbbbb", { threadId: threadB }));
  assert.equal(cursor.clicks.length, 0);
  assert.match(telegram.sent.at(-1).text, /pedido mudou|expirou|Sem permissão/i);
});

test("falha de gravação não impede a tentativa seguinte nem envia o prompt", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  let calls = 0;
  bridge.save = async () => {
    calls += 1;
    if (calls === 1) throw new Error("disco cheio");
  };
  await assert.rejects(() => bridge.persist(), /disco cheio/);
  await bridge.persist();
  assert.equal(calls, 2);

  bridge.save = async () => { throw new Error("disco cheio"); };
  await bridge.syncOnce().catch(() => {});
  const threadId = bridge.state.topics["mercado::a"]?.threadId;
  if (threadId) {
    const before = cursor.prompts.length;
    await bridge.handleUpdate(textUpdate(47, threadId, "não grava"));
    assert.equal(cursor.prompts.length, before);
    assert.equal(bridge.state.updateOffset || 0, 0);
  }
});

test("a mesma atualização não executa de novo e dois textos iguais são distintos", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const threadId = bridge.state.topics["mercado::a"].threadId;
  const update = textUpdate(48, threadId, "oi");
  await bridge.handleUpdate(update);
  await bridge.handleUpdate(update);
  assert.equal(cursor.prompts.length, 1);
  await bridge.handleUpdate(textUpdate(49, threadId, "oi"));
  assert.equal(cursor.prompts.length, 2);
});

test("reinício antes da execução preserva o pedido e execução interrompida não repete", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const threadId = bridge.state.topics["mercado::a"].threadId;
  const pending = structuredClone(bridge.state);
  pending.operations = [{
    id: "50:prompt:" + threadId,
    kind: "prompt",
    status: "pendente",
    text: "continua",
    threadId,
    destination: "mercado::a",
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    announced: true,
    ownerPid: 0,
  }];
  const restarted = bridgeFor(cursor, telegram, pending);
  await restarted.syncOnce();
  assert.ok(cursor.prompts.some((item) => item.text === "continua"));

  const interrupted = structuredClone(bridge.state);
  interrupted.operations = [{
    id: "51:prompt:" + threadId,
    kind: "prompt",
    status: "em_execucao",
    text: "nao repetir",
    threadId,
    destination: "mercado::a",
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerPid: -1,
  }];
  const again = bridgeFor(cursor, telegram, interrupted);
  const before = cursor.prompts.length;
  await again.syncOnce();
  assert.equal(cursor.prompts.filter((item) => item.text === "nao repetir").length, 0);
  assert.equal(cursor.prompts.length, before);
  assert.equal(again.state.operations.find((op) => op.text === "nao repetir").status, "resultado_incerto");
});

test("resultado incerto não é reenviado sozinho", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  cursor.forceUncertain = true;
  const threadId = bridge.state.topics["mercado::a"].threadId;
  await bridge.handleUpdate(textUpdate(52, threadId, "talvez"));
  assert.equal(cursor.prompts.length, 1);
  assert.match(telegram.sent.at(-1).text, /Resultado incerto/);
  await bridge.syncOnce();
  assert.equal(cursor.prompts.length, 1);
});

test("ultimo no tópico B não mostra o histórico de A", async () => {
  const cursor = new FakeCursor([windowOf({
    messages: [{ id: "s", role: "assistant", text: "segredo da auditoria" }],
  })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const threadB = bridge.state.topics["mercado::b"].threadId;
  await bridge.handleUpdate(textUpdate(53, threadB, "/ultimo"));
  const onB = telegram.sent.filter((message) => message.message_thread_id === threadB);
  assert.equal(onB.some((message) => String(message.text || "").includes("segredo da auditoria")), false);
  assert.match(onB.at(-1).text, /não está na tela|não vou mostrar/);
});

test("renomear conversa identificável preserva o tópico", async () => {
  const cursor = new FakeCursor([windowOf({
    tabs: [{ id: "perfil", stableId: "c1", title: "perfil", active: true, index: 0 }],
  })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const threadId = bridge.state.topics["mercado::perfil"].threadId;
  cursor.data[0].tabs = [{ id: "outro", stableId: "c1", title: "outro", active: true, index: 0 }];
  await bridge.syncOnce();
  assert.equal(bridge.state.topics["mercado::outro"].threadId, threadId);
  assert.equal(telegram.sent.filter((message) => String(message.text || "").includes("Aba ligada")).length, 1);
});

test("projetos com a mesma pasta não compartilham destino", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const threadId = bridge.state.topics["mercado::a"].threadId;
  cursor.data.push(windowOf({
    targetId: "w2",
    title: "copia - mercado - Cursor",
    tabs: [{ id: "a", title: "Auditoria", active: true, index: 0 }],
  }));
  await bridge.syncOnce();
  assert.equal(bridge.state.topics["mercado::a"].ambiguous, true);
  const before = cursor.prompts.length;
  await bridge.handleUpdate(textUpdate(54, threadId, "qual projeto"));
  assert.equal(cursor.prompts.length, before);
  assert.match(telegram.sent.at(-1).text, /ambígu/);
});

test("leitura ociosa não regrava nem renova o histórico", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  let saves = 0;
  bridge.save = async () => { saves += 1; };
  await bridge.syncOnce();
  const stamp = bridge.state.history["mercado::a"].updatedAt;
  const saved = saves;
  await bridge.syncOnce();
  assert.equal(saves, saved);
  assert.equal(bridge.state.history["mercado::a"].updatedAt, stamp);
});

test("avisa uma vez quando os seletores somem e avisa quando voltam", async () => {
  const broken = { sidebarCells: 0, messageNodes: 0, composer: 0, barTabs: 0 };
  const cursor = new FakeCursor([windowOf({ probe: broken })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  const notices = () => telegram.sent.filter((message) => /seletores da interface/.test(message.text || ""));
  await bridge.syncOnce();
  assert.equal(notices().length, 0);
  await bridge.syncOnce();
  assert.equal(notices().length, 1);
  await bridge.syncOnce();
  assert.equal(notices().length, 1);
  cursor.data[0].probe = { sidebarCells: 2, messageNodes: 4, composer: 1, barTabs: 1 };
  await bridge.syncOnce();
  assert.match(telegram.sent.at(-1).text, /Voltei a ler a interface/);
});

test("histórico longo marca o corte e a resposta vai em arquivo", async () => {
  const text = "a".repeat(20001);
  const cursor = new FakeCursor([windowOf({
    messages: [{ id: "longo", role: "assistant", text }],
    status: "idle",
  })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const stored = bridge.state.history["mercado::a"].messages[0];
  assert.equal(stored.truncated, true);
  assert.equal(stored.text.length, 20000);
  const file = telegram.sent.find((message) => message.document);
  assert.equal(file.document.length, 20001);
  assert.match(file.caption, /arquivo/);
});

test("anexo não entra no Cursor e a legenda vira o prompt", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const threadId = bridge.state.topics["mercado::a"].threadId;
  await bridge.handleUpdate({
    update_id: 91,
    message: {
      message_id: 9,
      message_thread_id: threadId,
      caption: "olhe esta imagem",
      photo: [{ file_id: "abc" }],
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  assert.match(telegram.sent.map((message) => message.text || "").join("\n"), /Não enviei o anexo/);
  assert.deepEqual(cursor.prompts.at(-1), { targetId: "w1", text: "olhe esta imagem", title: "Auditoria" });
});

test("botão atrasado ainda abre a ajuda", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  telegram.answerCallback = async () => {
    throw new Error("Bad Request: query is too old and response timeout expired or query ID is invalid");
  };
  const bridge = bridgeFor(cursor, telegram);
  bridge.state.forum = true;
  await bridge.handleUpdate({
    update_id: 93,
    callback_query: {
      id: "velho",
      data: "m:ajuda",
      from: { id: 42 },
      message: { message_thread_id: 1, chat: { id: -1001 } },
    },
  });
  assert.match(telegram.sent.at(-1).text, /Escreva no tópico/);
});

test("ajuda responde enquanto a leitura do Cursor ainda não terminou", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cursor = new FakeCursor([windowOf()]);
  cursor.windows = () => gate.then(() => cursor.data);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  const sync = bridge.syncOnce();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const reply = bridge.handleUpdate({
    update_id: 94,
    message: {
      message_id: 12,
      message_thread_id: 1,
      text: "/ajuda",
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  const result = await Promise.race([
    reply.then(() => "ok"),
    new Promise((resolve) => setTimeout(() => resolve("preso"), 400)),
  ]);
  assert.equal(result, "ok");
  assert.match(telegram.sent.at(-1).text, /Escreva no tópico/);
  release();
  await sync;
});

test("sem tópicos, /parar usa a conversa escolhida", async () => {
  const cursor = new FakeCursor([windowOf()]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  bridge.state.forum = false;
  bridge.windows = cursor.data;
  bridge.state.activeTabKey = "mercado::a";
  await bridge.handleUpdate({
    update_id: 92,
    message: {
      message_id: 10,
      text: "/parar",
      from: { id: 42 },
      chat: { id: -1001 },
    },
  });
  assert.equal(cursor.clicks.length, 1);
  assert.equal(cursor.clicks[0].kind, "stop");
  assert.match(telegram.sent.at(-1).text, /Auditoria/);
});
