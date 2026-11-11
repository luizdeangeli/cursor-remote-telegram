import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { CursorClient } from "./cursor.mjs";
import { fingerprint, planOutbound, tabKey, topicTitle } from "./delivery.mjs";
import { loadConfig, rootDir } from "./env.mjs";
import { loadState, saveState } from "./state.mjs";
import { Telegram } from "./telegram.mjs";

function menuMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "Abas", callback_data: "m:abas" },
        { text: "Recarregar", callback_data: "m:recarregar" },
      ],
      [
        { text: "Status", callback_data: "m:status" },
        { text: "Tela", callback_data: "m:tela" },
      ],
      [
        { text: "Parar", callback_data: "m:parar" },
        { text: "Ajuda", callback_data: "m:ajuda" },
      ],
    ],
  };
}

const topicIcons = {
  idle: "5417915203100613993",
  running: "5312016608254762256",
  waiting_approval: "5379748062124056162",
};

export function commandOf(text) {
  const match = String(text || "").trim().match(/^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { name: match[1].toLowerCase(), arg: (match[2] || "").trim() };
}

export class Bridge {
  constructor({ config, state, telegram, cursor, log = () => {}, save = saveState }) {
    this.config = config;
    this.state = state;
    this.telegram = telegram;
    this.cursor = cursor;
    this.log = log;
    this.save = save;
    this.windows = [];
    this.running = true;
    this.saveChain = Promise.resolve();
    this.syncChain = Promise.resolve();
  }

  exclusive(fn) {
    const run = this.syncChain.then(() => fn());
    this.syncChain = run.then(() => {}, () => {});
    return run;
  }

  chatId() {
    return String(this.config.chatId || this.state.chatId || "");
  }

  async persist() {
    const payload = structuredClone(this.state);
    this.saveChain = this.saveChain.then(() => this.save(payload));
    await this.saveChain;
  }

  tabs() {
    const list = [];
    for (const window of this.windows) {
      if (window.error) continue;
      const tabs = window.tabs?.length
        ? window.tabs
        : [{ id: "ativa", title: window.title || "Agente", active: true, index: 0, synthetic: true }];
      for (const tab of tabs) {
        list.push({
          key: tabKey(window.title, tab),
          title: topicTitle(window.title, tab),
          window,
          tab,
          active: Boolean(tab.active),
          synthetic: Boolean(tab.synthetic),
        });
      }
    }
    return list;
  }

  findTab(key) {
    return this.tabs().find((tab) => tab.key === key) || null;
  }

  tabByThread(threadId) {
    if (!threadId || threadId === 1) return null;
    const entry = Object.entries(this.state.topics).find(([, topic]) => topic.threadId === threadId);
    if (!entry) return null;
    return this.findTab(entry[0]) || { key: entry[0], title: entry[1].title, missing: true };
  }

  currentTab(threadId) {
    return this.tabByThread(threadId)
      || this.findTab(this.state.activeTabKey)
      || this.tabs().find((tab) => tab.active)
      || this.tabs()[0]
      || null;
  }

  async reply(threadId, text, extra = {}) {
    const chatId = this.chatId();
    if (!chatId) return null;
    const payload = { ...extra };
    if (threadId && threadId !== 1) payload.message_thread_id = threadId;
    if (threadId === 1 && this.state.generalDirect !== false) {
      try {
        return await this.telegram.sendText(chatId, text, { ...payload, message_thread_id: 1 });
      } catch (error) {
        if (!/thread not found/i.test(error.message)) throw error;
        this.state.generalDirect = false;
      }
    }
    return this.telegram.sendText(chatId, text, payload);
  }

  async forgetTopic(chatId, key) {
    const topic = this.state.topics[key];
    if (!topic) return true;
    try {
      await this.telegram.deleteForumTopic(chatId, topic.threadId);
    } catch (error) {
      if (!/not found|topic.?deleted|thread not found/i.test(error.message)) {
        this.log(`apagar tópico: ${error.message}`);
        return false;
      }
    }
    delete this.state.topics[key];
    return true;
  }

  moveTopic(oldKey, newKey, targetId) {
    if (!this.state.topics[oldKey]) return;
    if (oldKey !== newKey) {
      this.state.topics[newKey] = { ...this.state.topics[oldKey], targetId };
      delete this.state.topics[oldKey];
      for (const field of ["sent", "ownPrompts"]) {
        const bag = this.state[field];
        if (!bag?.[oldKey]) continue;
        const merged = [...(bag[newKey] || []), ...bag[oldKey]];
        bag[newKey] = merged.slice(-200);
        delete bag[oldKey];
      }
      if (this.state.progress?.[oldKey] && !this.state.progress[newKey]) {
        this.state.progress[newKey] = this.state.progress[oldKey];
      }
      delete this.state.progress?.[oldKey];
      if (this.state.approvals?.[oldKey] && !this.state.approvals[newKey]) {
        this.state.approvals[newKey] = this.state.approvals[oldKey];
      }
      delete this.state.approvals?.[oldKey];
      return;
    }
    this.state.topics[newKey].targetId = targetId;
  }

  async syncTopics({ prune = false } = {}) {
    const chatId = this.chatId();
    if (!chatId) return;
    if (this.state.forum !== true) {
      const now = Date.now();
      if (this.state.forum === false && now - (this.state.forumCheckedAt || 0) < 30000) return;
      this.state.forumCheckedAt = now;
      try {
        const chat = await this.telegram.getChat(chatId);
        this.state.forum = Boolean(chat.is_forum);
      } catch (error) {
        this.log(`chat: ${error.message}`);
        return;
      }
      if (!this.state.forum) return;
    }
    for (const [key, topic] of Object.entries(this.state.topics)) {
      if (!/^(.+) · \1$/.test(topic.title || "")) continue;
      await this.forgetTopic(chatId, key);
    }
    if (prune) {
      const live = new Set(this.tabs().map((tab) => tab.key));
      const liveTitles = new Set(this.tabs().map((tab) => tab.title));
      const erroredTargets = new Set(this.windows.filter((window) => window.error).map((window) => window.targetId));
      for (const [key, topic] of Object.entries(this.state.topics)) {
        if (live.has(key) || liveTitles.has(topic.title)) continue;
        if (topic.targetId && erroredTargets.has(topic.targetId)) continue;
        await this.forgetTopic(chatId, key);
      }
    }
    for (const tab of this.tabs()) {
      if (tab.synthetic) continue;
      const folder = `${tab.key.split("::")[0]}::`;
      const sameTitle = Object.entries(this.state.topics)
        .filter(([key, topic]) => topic.title === tab.title && key.startsWith(folder))
        .sort((a, b) => (b[1].threadId || 0) - (a[1].threadId || 0));
      if (sameTitle.length) {
        const [keepKey] = sameTitle[0];
        for (const [key] of sameTitle.slice(1)) await this.forgetTopic(chatId, key);
        this.moveTopic(keepKey, tab.key, tab.window.targetId);
        continue;
      }
      const known = this.state.topics[tab.key];
      if (!known) {
        try {
          const topic = await this.telegram.createForumTopic(chatId, tab.title);
          this.state.forum = true;
          this.state.topics[tab.key] = {
            threadId: topic.message_thread_id,
            title: tab.title,
            targetId: tab.window.targetId,
          };
          await this.persist();
          await this.telegram.sendText(
            chatId,
            "Aba ligada. Escreva aqui para falar com este agente.",
            { message_thread_id: topic.message_thread_id },
          );
        } catch (error) {
          if (/forum|topic/i.test(error.message)) {
            this.state.forum = false;
            this.state.forumCheckedAt = Date.now();
            await this.telegram.sendText(chatId, "Este chat não tem tópicos. Use /abas e /usar N.");
            return;
          }
          this.log(`tópico: ${error.message}`);
        }
      } else {
        known.targetId = tab.window.targetId;
        if (known.title !== tab.title) {
          try {
            await this.telegram.editForumTopic(chatId, known.threadId, tab.title);
          } catch (error) {
            this.log(`renomear tópico: ${error.message}`);
          }
          known.title = tab.title;
        }
      }
    }
  }

  async publish() {
    const chatId = this.chatId();
    if (!chatId) return;
    for (const tab of this.tabs()) {
      if (!tab.active) continue;
      const key = tab.key;
      const sent = this.state.sent[key] || [];
      const planned = planOutbound({
        messages: tab.window.messages || [],
        status: tab.window.status,
        activity: tab.window.activity,
        sent,
        ownPrompts: this.state.ownPrompts[key] || [],
      });
      const threadId = this.state.topics[key]?.threadId;
      if (!threadId && this.state.forum !== false) continue;
      const extra = threadId ? { message_thread_id: threadId } : {};
      for (const item of [...planned.echoes, ...planned.finals]) {
        const prefix = item.role === "human" ? "Você no Cursor:\n" : "";
        await this.telegram.sendText(chatId, `${prefix}${item.text}`, extra);
        sent.push(item.hash);
      }
      this.state.sent[key] = sent.slice(-200);

      const progress = this.state.progress[key] || {};
      if (planned.progress && planned.progress !== progress.text) {
        try {
          if (progress.messageId) await this.telegram.editText(chatId, progress.messageId, planned.progress);
          else {
            const sentMessage = await this.telegram.sendText(chatId, planned.progress, extra);
            progress.messageId = sentMessage?.message_id;
          }
          progress.text = planned.progress;
        } catch (error) {
          if (!/not modified/i.test(error.message)) this.log(`andamento: ${error.message}`);
        }
      } else if (!planned.progress && progress.messageId) {
        try {
          await this.telegram.deleteMessage(chatId, progress.messageId);
        } catch (error) {
          if (!/not found|can't be deleted|message to delete/i.test(error.message)) {
            this.log(`andamento: ${error.message}`);
          }
        }
        progress.messageId = null;
        progress.text = "";
      }
      this.state.progress[key] = progress;

      const approval = tab.window.approvals?.[0];
      const approvalHash = approval ? fingerprint(`${approval.command}\n${approval.label}`) : "";
      const previous = this.state.approvals[key];
      if (approval && previous?.hash !== approvalHash) {
        const id = fingerprint(`${key}:${approvalHash}`).slice(0, 10);
        this.state.approvals[key] = { hash: approvalHash, short: id, index: approval.index || 0 };
        await this.telegram.sendText(
          chatId,
          `Aprovar este passo?\n${approval.command || approval.label}`,
          {
            ...extra,
            reply_markup: {
              inline_keyboard: [[
                { text: "Aprovar", callback_data: `a:${id}` },
                { text: "Recusar", callback_data: `r:${id}` },
              ]],
            },
          },
        );
      } else if (!approval) {
        this.state.approvals[key] = null;
      }
    }
    await this.syncIcons();
  }

  async syncIcons() {
    const chatId = this.chatId();
    if (!chatId || this.state.forum === false) return;
    for (const tab of this.tabs()) {
      const topic = this.state.topics[tab.key];
      if (!topic?.threadId) continue;
      const mode = tab.active && topicIcons[tab.window.status] ? tab.window.status : "idle";
      if (topic.icon === mode) continue;
      try {
        await this.telegram.setForumTopicIcon(chatId, topic.threadId, topicIcons[mode]);
        topic.icon = mode;
      } catch (error) {
        if (!/not modified/i.test(error.message)) this.log(`ícone: ${error.message}`);
      }
    }
  }

  async syncOnce() {
    return this.exclusive(() => this.syncBody());
  }

  async syncBody() {
    try {
      this.windows = await this.cursor.windows();
      if (this.state.cdpDownNotified) this.state.cdpDownNotified = false;
    } catch (error) {
      this.windows = [];
      this.log(`Cursor: ${error.message}`);
      if (!this.state.cdpDownNotified && this.chatId()) {
        await this.telegram.sendText(
          this.chatId(),
          "Não consigo ver o Cursor. Feche o Cursor e abra de novo com bin/cursor-debug.",
        );
        this.state.cdpDownNotified = true;
      }
      await this.persist();
      return;
    }
    await this.syncTopics();
    await this.ensureMenu();
    await this.publish();
    await this.persist();
  }

  async ensureMenu() {
    const chatId = this.chatId();
    if (!chatId || this.state.forum === false || this.state.menuMessageId) return;
    const sent = await this.reply(1, "Menu. Toque um botão. Para falar com um agente, use o tópico da conversa.", {
      reply_markup: menuMarkup(),
    });
    this.state.menuMessageId = sent?.message_id || null;
    if (!this.state.menuMessageId) return;
    try {
      await this.telegram.pinChatMessage(chatId, this.state.menuMessageId);
    } catch (error) {
      this.log(`fixar menu: ${error.message}`);
    }
  }

  async handleUpdate(update) {
    if (update.update_id != null) this.state.updateOffset = update.update_id + 1;
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      await this.persist();
      return;
    }
    const message = update.message;
    if (!message || message.from?.is_bot) return;
    const userId = message.from?.id;
    if (userId == null) return;
    const expected = this.config.allowedUserId || this.state.allowedUserId;
    if (expected && String(userId) !== String(expected)) return;
    if (!expected) this.state.allowedUserId = String(userId);

    const chatId = String(message.chat.id);
    if (this.config.chatId && chatId !== String(this.config.chatId)) return;
    if (!this.config.chatId && this.state.chatId && chatId !== String(this.state.chatId)) return;
    if (!this.state.chatId) {
      this.state.chatId = chatId;
      try {
        const chat = await this.telegram.getChat(chatId);
        this.state.forum = Boolean(chat.is_forum);
      } catch (error) {
        this.log(`chat: ${error.message}`);
      }
    }

    const text = message.text || "";
    const command = commandOf(text);
    const threadId = message.message_thread_id || 0;
    if (command) await this.handleCommand(command, threadId);
    else if (text.trim()) await this.handleText(text.trim(), threadId);
    await this.persist();
  }

  async handleText(text, threadId) {
    if (this.state.forum !== false && (!threadId || threadId === 1)) {
      await this.reply(threadId, "Escreva dentro do tópico da aba. Os botões do menu ficam no General.", {
        reply_markup: menuMarkup(),
      });
      return;
    }
    const tab = this.currentTab(threadId);
    if (!tab || tab.missing || !tab.window) {
      await this.reply(threadId, "Não achei essa aba aberta no Cursor.");
      return;
    }
    const own = this.state.ownPrompts[tab.key] || [];
    own.push(text);
    this.state.ownPrompts[tab.key] = own.slice(-20);
    try {
      await this.cursor.sendPrompt(tab.window.targetId, text, tab.tab?.index, tab.tab?.title);
      await this.reply(threadId, "Enviado.");
    } catch (error) {
      await this.reply(threadId, `Não consegui enviar: ${error.message}`);
    }
  }

  async handleCommand(command, threadId) {
    if (command.name === "menu") {
      this.state.menuMessageId = null;
      await this.ensureMenu();
      return;
    }
    if (command.name === "status" || command.name === "start" || command.name === "ajuda" || command.name === "help") {
      if (command.name !== "status") {
        await this.reply(threadId, [
          "Escreva no tópico da aba para mandar um prompt.",
          "No General, use os botões ou os comandos:",
          "/abas — lista as abas",
          "/usar N — escolhe a aba quando não há tópicos",
          "/status — ponte e janelas",
          "/ultimo N — reenvia as últimas mensagens",
          "/tela — captura a janela",
          "/parar — interrompe o agente",
          "/recarregar — relê as abas e atualiza os tópicos",
          "/menu — mostra os botões de novo",
        ].join("\n"), { reply_markup: menuMarkup() });
        if (command.name !== "status") return;
      }
    }
    if (command.name === "status") {
      const lines = [
        `Chat ${this.chatId() || "ainda não definido"}`,
        `Tópicos: ${this.state.forum === false ? "não" : "sim"}`,
        `Janelas visíveis: ${this.windows.filter((window) => !window.error).length}`,
      ];
      if (!this.windows.length) lines.push("Porta 9222 sem janelas. Abra o Cursor com bin/cursor-debug.");
      else lines.push(...this.windows.map((window) => `• ${window.title} (${window.status || "?"})`));
      await this.reply(threadId, lines.join("\n"));
      return;
    }
    if (command.name === "abas" || command.name === "usar") {
      const tabs = this.tabs();
      if (command.name === "usar") {
        const chosen = tabs[Number(command.arg) - 1];
        if (!chosen) {
          await this.reply(threadId, "Número inválido. /abas mostra a lista.");
          return;
        }
        this.state.activeTabKey = chosen.key;
        await this.reply(threadId, `Usando ${chosen.title}`);
        return;
      }
      await this.reply(threadId, tabs.length
        ? tabs.map((tab, index) => `${index + 1}. ${tab.title}${tab.active ? " (ativa)" : ""}`).join("\n")
        : "Nenhuma aba visível.");
      return;
    }
    if (command.name === "recarregar" || command.name === "reload") {
      if (this.state.forum !== false && threadId && threadId !== 1) {
        await this.reply(threadId, "Use /recarregar no General.");
        return;
      }
      let skipped = false;
      try {
        await this.exclusive(async () => {
          this.windows = await this.cursor.windows();
          if (!this.windows.some((window) => !window.error)) {
            skipped = true;
            return;
          }
          await this.syncTopics({ prune: true });
          await this.persist();
        });
      } catch (error) {
        await this.reply(threadId, `Não consegui ler o Cursor: ${error.message}`);
        return;
      }
      if (skipped) {
        await this.reply(threadId, "Não vejo o Cursor. Abra com bin/cursor-debug e tente de novo.");
        return;
      }
      const tabs = this.tabs();
      await this.reply(threadId, tabs.length
        ? `Abas recarregadas (${tabs.length}):\n${tabs.map((tab, index) => `${index + 1}. ${tab.title}${tab.active ? " (ativa)" : ""}`).join("\n")}`
        : "Nenhuma aba visível.");
      return;
    }
    const tab = this.currentTab(threadId);
    if (command.name === "ultimo") {
      if (!tab?.window) {
        await this.reply(threadId, "Nenhuma aba selecionada.");
        return;
      }
      const count = Math.min(Number(command.arg) || 5, 20);
      const messages = (tab.window.messages || []).filter((message) => message.text).slice(-count);
      if (!messages.length) {
        await this.reply(threadId, "Sem mensagens nesta aba.");
        return;
      }
      for (const message of messages) {
        const prefix = message.role === "human" ? "Você: " : "";
        await this.reply(threadId, `${prefix}${message.text}`);
      }
      return;
    }
    if (command.name === "tela") {
      if (!tab?.window) {
        await this.reply(threadId, "Nenhuma janela para capturar.");
        return;
      }
      try {
        const png = await this.cursor.screenshot(tab.window.targetId);
        await this.telegram.sendPhoto(this.chatId(), png, {
          message_thread_id: threadId || undefined,
          caption: tab.title,
        });
      } catch (error) {
        await this.reply(threadId, `Não consegui capturar a tela: ${error.message}`);
      }
      return;
    }
    if (command.name === "parar") {
      if (!tab?.window) {
        await this.reply(threadId, "Nenhuma aba selecionada.");
        return;
      }
      try {
        await this.cursor.clickKind(tab.window.targetId, "stop");
        await this.reply(threadId, "Pedido de parada enviado.");
      } catch (error) {
        await this.reply(threadId, `Não achei o botão de parar: ${error.message}`);
      }
    }
  }

  async handleCallback(query) {
    const expected = this.config.allowedUserId || this.state.allowedUserId;
    if (expected && String(query.from?.id) !== String(expected)) {
      await this.telegram.answerCallback(query.id, "Sem permissão");
      return;
    }
    const data = query.data || "";
    if (data.startsWith("m:")) {
      const name = data.slice(2);
      const threadId = query.message?.message_thread_id || 1;
      await this.telegram.answerCallback(query.id, "");
      await this.handleCommand({ name, arg: "" }, threadId);
      return;
    }
    const kind = data.startsWith("a:") ? "approve" : data.startsWith("r:") ? "reject" : "";
    const entry = Object.entries(this.state.approvals).find(([, value]) => value?.short === data.slice(2));
    if (!kind || !entry) {
      await this.telegram.answerCallback(query.id, "Esse pedido expirou");
      return;
    }
    const [key, approval] = entry;
    const tab = this.findTab(key);
    if (!tab?.window) {
      await this.telegram.answerCallback(query.id, "Aba fechada");
      return;
    }
    try {
      await this.cursor.clickKind(tab.window.targetId, kind, approval.index || 0);
      await this.telegram.answerCallback(query.id, kind === "approve" ? "Aprovado" : "Recusado");
    } catch (error) {
      await this.telegram.answerCallback(query.id, error.message.slice(0, 180));
    }
  }

  async cursorLoop() {
    while (this.running) {
      try {
        await this.syncOnce();
      } catch (error) {
        this.log(error.message);
      }
      await sleep(this.config.pollIntervalMs);
    }
  }

  async telegramLoop() {
    while (this.running) {
      try {
        const updates = await this.telegram.getUpdates(this.state.updateOffset || undefined, 25);
        for (const update of updates) await this.handleUpdate(update);
      } catch (error) {
        this.log(`Telegram: ${error.message}`);
        await sleep(3000);
      }
    }
  }
}

async function main() {
  let config = await loadConfig();
  while (!config.token) {
    console.error("Falta TELEGRAM_BOT_TOKEN em .env. Aguardando...");
    await sleep(15000);
    config = await loadConfig();
  }
  const selectors = JSON.parse(await readFile(path.join(rootDir, "selectors.json"), "utf8"));
  const state = await loadState();
  if (config.chatId) state.chatId = config.chatId;
  if (config.allowedUserId) state.allowedUserId = config.allowedUserId;
  const telegram = new Telegram(config.token, config.apiBase);
  if (state.chatId && state.forum == null) {
    try {
      const chat = await telegram.getChat(state.chatId);
      state.forum = Boolean(chat.is_forum);
    } catch (error) {
      console.error(`Não consegui ler o chat: ${error.message}`);
    }
  }
  const bridge = new Bridge({
    config,
    state,
    telegram,
    cursor: new CursorClient(config.cdpUrl, selectors),
    log: (line) => console.error(line),
  });
  const stop = () => {
    bridge.running = false;
    bridge.cursor.close();
    const timer = setTimeout(() => process.exit(0), 3000);
    bridge.saveChain.finally(() => {
      clearTimeout(timer);
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await telegram.setMyCommands([
      { command: "menu", description: "Mostra os botões" },
      { command: "abas", description: "Lista as conversas" },
      { command: "recarregar", description: "Atualiza os tópicos" },
      { command: "status", description: "Estado da ponte" },
      { command: "tela", description: "Captura a janela ativa" },
      { command: "parar", description: "Interrompe o agente ativo" },
      { command: "ajuda", description: "Como usar" },
    ]);
  } catch (error) {
    console.error(`comandos: ${error.message}`);
  }
  if (state.chatId && state.forum !== false) {
    try {
      await bridge.ensureMenu();
      await bridge.persist();
    } catch (error) {
      console.error(`menu: ${error.message}`);
    }
  }
  console.error(`Ponte no ar. CDP ${config.cdpUrl}`);
  await Promise.all([bridge.cursorLoop(), bridge.telegramLoop()]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
