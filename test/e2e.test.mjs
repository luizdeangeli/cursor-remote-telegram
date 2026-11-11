import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Bridge } from "../src/bridge.mjs";
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
  }

  async windows() {
    if (this.fail) throw new Error("conexão recusada");
    return this.data;
  }

  async sendPrompt(targetId, text, index) {
    this.prompts.push({ targetId, text, index });
  }

  async clickKind(targetId, kind, index) {
    this.clicks.push({ targetId, kind, index });
  }

  async screenshot() {
    return Buffer.from("png");
  }
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

  async editForumTopic() {}

  async setForumTopicIcon(_chatId, threadId, emojiId) {
    this.icons = this.icons || [];
    this.icons.push({ threadId, emojiId });
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

  async answerCallback(id, text) {
    this.sent.push({ callback: id, text });
  }

  async getChat() {
    return { is_forum: true };
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
  assert.deepEqual(cursor.prompts, [{ targetId: "w1", text: "revisa o login", index: 0 }]);
  assert.equal(telegram.sent.at(-1).text, "Enviado.");
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
  assert.equal(bridge.state.topics["velha::x"], undefined);
  assert.deepEqual(telegram.deletedTopics, [99]);
  assert.match(telegram.sent.at(-1).text, /Abas recarregadas \(2\)/);
  assert.equal(telegram.sent.at(-1).message_thread_id, 1);
});

test("aprova e recusa pelo botão, e ignora outro usuário", async () => {
  const cursor = new FakeCursor([windowOf({
    status: "waiting_approval",
    activity: "Aguardando aprovação",
    approvals: [{ index: 0, label: "Run", command: "npm test" }],
  })]);
  const telegram = new FakeTelegram();
  const bridge = bridgeFor(cursor, telegram);
  await bridge.syncOnce();
  const ask = telegram.sent.find((message) => message.text.includes("npm test"));
  assert.equal(ask.reply_markup.inline_keyboard[0][0].text, "Aprovar");
  const data = ask.reply_markup.inline_keyboard[0][0].callback_data;

  await bridge.handleUpdate({
    update_id: 2,
    callback_query: { id: "cb1", data, from: { id: 99 } },
  });
  assert.equal(cursor.clicks.length, 0);

  await bridge.handleUpdate({
    update_id: 3,
    callback_query: { id: "cb2", data, from: { id: 42 } },
  });
  assert.equal(cursor.clicks[0].kind, "approve");

  const reject = ask.reply_markup.inline_keyboard[0][1].callback_data;
  await bridge.handleUpdate({
    update_id: 4,
    callback_query: { id: "cb3", data: reject, from: { id: 42 } },
  });
  assert.equal(cursor.clicks[1].kind, "reject");
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
