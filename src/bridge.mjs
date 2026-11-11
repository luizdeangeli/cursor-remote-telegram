import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  approvalHash,
  approvalStillMatches,
  createApprovalToken,
  judgeCallback,
  reconcileTokens,
} from "./approvals.mjs";
import { CursorClient } from "./cursor.mjs";
import { chunkText, conversationName, normalizeText, planOutbound, projectName, shortId, topicTitle, topicUrl } from "./delivery.mjs";
import { diagnosticReport, selectorsBroken } from "./diagnostics.mjs";
import { loadConfig, rootDir, validateConfig } from "./env.mjs";
import { annotateWindows, findExistingTopic, storageKey } from "./identity.mjs";
import { admitOperation, isRunnable, operationId, OPERATION_TTL_MS, reconcileOperations } from "./queue.mjs";
import { resolveDestination } from "./routing.mjs";
import { acquireLock, BACKUP_INTERVAL_MS, loadState, pruneHistory, releaseLock, saveState } from "./state.mjs";
import { classifyTelegramError, Telegram } from "./telegram.mjs";

const TOPIC_PAGE = 8;
const MENU_VERSION = 4;

function menuText(selected) {
  return selected
    ? "Escolhidas. Toque em Projetos para incluir ou abrir uma conversa."
    : "Todas. Toque em Projetos para abrir uma conversa.";
}

function menuMarkup() {
  return {
    inline_keyboard: [
      [
        { text: "Projetos", callback_data: "m:projetos" },
      ],
      [
        { text: "Ativas", callback_data: "m:ativas" },
      ],
      [
        { text: "Status", callback_data: "m:status" },
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

const helpText = [
  "Escreva no tópico da aba para mandar um prompt.",
  "No General, use os botões ou os comandos:",
  "/abas — lista as conversas, agrupadas por projeto",
  "/ativas — a conversa visível de cada Cursor",
  "/usar N — escolhe a aba quando não há tópicos",
  "/status — ponte e janelas",
  "/diagnostico — o que falhou e o próximo passo",
  "/ultimo N — reenvia o histórico desta conversa",
  "/limpar — apaga o histórico local desta conversa",
  "/tela — captura a conversa deste tópico",
  "/parar — interrompe o agente deste tópico",
  "/esquecer — apaga o tópico e o histórico, depois de confirmar",
  "/recarregar — no modo escolhidas, pede confirmação e apaga os tópicos; no modo todas, marca as conversas fechadas",
  "/projetos — lista os projetos e, no modo escolhidas, inclui a conversa",
  "/ocultar — deixa de espelhar a conversa deste tópico",
  "/parear CODIGO — autoriza a conta e o grupo",
  "/menu — mostra os botões de novo",
].join("\n");

export function commandOf(text) {
  const match = String(text || "").trim().match(/^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { name: match[1].toLowerCase(), arg: (match[2] || "").trim() };
}

export class Bridge {
  constructor({ config, state, telegram, cursor, log = () => {}, save = saveState, releaseLock: unlock = null }) {
    this.config = config;
    this.state = state;
    this.telegram = telegram;
    this.cursor = cursor;
    this.log = log;
    this.save = save;
    this.releaseLock = unlock;
    this.windows = [];
    this.running = true;
    this.intakeOpen = true;
    this.shuttingDown = false;
    this.pendingNotices = [];
    this.saveChain = Promise.resolve();
    this.syncChain = Promise.resolve();
    this.selectorMisses = 0;
    this.lastSavedSignature = "";
    this.lastCheckpointAt = 0;
  }

  exclusive(fn) {
    const run = this.syncChain.then(() => fn());
    this.syncChain = run.then(() => {}, () => {});
    return run;
  }

  logEvent(category, fields = {}) {
    const bits = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value == null || value === "" || key === "text" || key === "token") continue;
      bits.push(`${key}=${String(value).replace(/\s+/g, " ").slice(0, 180)}`);
    }
    this.log(`${new Date().toISOString()} ${category}${bits.length ? ` ${bits.join(" ")}` : ""}`);
  }

  chatId() {
    return String(this.config.chatId || this.state.chatId || "");
  }

  authorizedUser() {
    return String(this.config.allowedUserId || this.state.allowedUserId || "");
  }

  async persist() {
    const payload = structuredClone(this.state);
    const signature = savedSignature(payload);
    const now = Date.now();
    if (signature === this.lastSavedSignature && now - this.lastCheckpointAt < BACKUP_INTERVAL_MS) return;
    const run = this.saveChain.catch(() => {}).then(async () => {
      await this.save(payload);
      this.lastSavedSignature = signature;
      this.lastCheckpointAt = Date.now();
    });
    this.saveChain = run.then(() => {}, () => {});
    await run;
  }

  async stage(mutator) {
    const backup = structuredClone(this.state);
    mutator();
    try {
      await this.persist();
    } catch (error) {
      for (const key of Object.keys(this.state)) delete this.state[key];
      Object.assign(this.state, backup);
      throw error;
    }
  }

  tabs() {
    annotateWindows(this.windows);
    const list = [];
    for (const window of this.windows) {
      if (window.error) continue;
      const source = window.tabs?.length
        ? window.tabs
        : [{ id: "ativa", title: window.title || "Agente", active: true, index: 0, synthetic: true }];
      for (const tab of source) {
        list.push({
          key: storageKey(window, tab),
          title: topicTitle(window.title, tab),
          window,
          tab,
          active: Boolean(tab.active),
          synthetic: Boolean(tab.synthetic),
          ambiguous: Boolean(tab.ambiguous || window.projectAmbiguous),
          stableId: tab.stableId || "",
          projectName: window.projectName || "",
          workspacePath: window.workspacePath || "",
        });
      }
    }
    const counts = new Map();
    for (const tab of list) {
      if (tab.synthetic || tab.stableId) continue;
      const id = `${tab.projectName}::${tab.tab?.title || ""}`;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    for (const tab of list) {
      if (tab.synthetic || tab.stableId) continue;
      const id = `${tab.projectName}::${tab.tab?.title || ""}`;
      if ((counts.get(id) || 0) > 1) tab.ambiguous = true;
    }
    return list;
  }

  destination(threadId, purpose) {
    return resolveDestination({
      threadId,
      forum: this.state.forum,
      topics: this.state.topics,
      tabs: this.tabs(),
      activeTabKey: this.state.activeTabKey,
      purpose,
    });
  }

  titleMatches(surface, title) {
    const wanted = normalizeText(title);
    if (!wanted) return false;
    return normalizeText(surface?.title) === wanted || normalizeText(surface?.activeTab) === wanted;
  }

  async postToThread(threadId, send) {
    const chatId = this.chatId();
    if (!chatId) return null;
    if (threadId === 1 && this.state.generalDirect !== false) {
      try {
        return await send(chatId, { message_thread_id: 1 });
      } catch (error) {
        if (!/thread not found/i.test(error.message)) throw error;
        this.state.generalDirect = false;
      }
    }
    const thread = threadId && threadId !== 1 ? { message_thread_id: threadId } : {};
    return send(chatId, thread);
  }

  async reply(threadId, text, extra = {}) {
    return this.postToThread(threadId, (chatId, thread) =>
      this.telegram.sendText(chatId, text, { ...extra, ...thread }));
  }

  async forgetTopic(chatId, key) {
    const topic = this.state.topics[key];
    if (!topic) return true;
    try {
      await this.telegram.deleteForumTopic(chatId, topic.threadId);
    } catch (error) {
      if (!/not found|topic.?deleted|thread not found/i.test(error.message)) {
        this.logEvent("telegram", { event: "delete_topic", error: error.message, dest: key });
        return false;
      }
    }
    delete this.state.topics[key];
    return true;
  }

  clearMirror() {
    this.state.topics = {};
    this.state.shared = {};
    this.state.sent = {};
    this.state.progress = {};
    this.state.approvals = {};
    this.state.approvalTokens = {};
    this.state.ownPrompts = {};
    this.state.operations = [];
    this.state.history = {};
    this.state.outbound = {};
    this.state.forgetTokens = {};
    this.state.ambiguityNotified = {};
    this.state.activeTabKey = "";
  }

  async dropAllTopics() {
    const chatId = this.chatId();
    let removed = 0;
    let failed = 0;
    for (const key of Object.keys(this.state.topics)) {
      const threadId = this.state.topics[key]?.threadId;
      if (!threadId || threadId === 1) {
        delete this.state.topics[key];
        continue;
      }
      if (await this.forgetTopic(chatId, key)) removed += 1;
      else failed += 1;
    }
    if (!failed) this.clearMirror();
    return { removed, failed };
  }

  async confirmReload(threadId) {
    await this.reply(threadId, "Isso apaga os tópicos espelhados e a seleção.", {
      reply_markup: {
        inline_keyboard: [[
          { text: "Apagar os tópicos", callback_data: "c:limpar" },
          { text: "Cancelar", callback_data: "c:cancelar" },
        ]],
      },
    });
  }

  async reloadChosen(threadId) {
    let skipped = false;
    try {
      this.windows = await this.cursor.windows();
      this.state.lastCursorReadAt = Date.now();
      if (!this.windows.some((window) => !window.error)) skipped = true;
      else {
        this.reloadReset = await this.dropAllTopics();
        if (!this.reloadReset.failed) await this.syncTopics();
      }
      await this.persist();
    } catch (error) {
      await this.reply(threadId, `Não consegui ler o Cursor: ${error.message}`);
      return;
    }
    if (skipped) {
      await this.reply(threadId, "Não vejo o Cursor. Abra com bin/cursor-debug e tente de novo.");
      return;
    }
    const reset = this.reloadReset || { removed: 0, failed: 0 };
    if (reset.failed) {
      await this.reply(threadId, `Apaguei ${reset.removed}. ${reset.failed} continuam no grupo. Mande /recarregar de novo.`);
      return;
    }
    await this.reply(threadId, `Conversas limpas (${reset.removed}). Use Projetos e Incluir para espelhar de novo.`);
  }

  sharesSelected() {
    return this.config.shareMode === "escolhidas";
  }

  keyByShort(short) {
    const keys = new Set([
      ...this.tabs().map((tab) => tab.key),
      ...Object.keys(this.state.topics || {}),
      ...Object.keys(this.state.shared || {}),
    ]);
    return [...keys].find((key) => shortId(key) === short) || "";
  }

  openProjects() {
    annotateWindows(this.windows);
    const names = new Set();
    for (const window of this.windows) {
      if (window.error) continue;
      names.add(window.projectName || projectName(window.title || ""));
    }
    return [...names].sort((a, b) => a.localeCompare(b, "pt"));
  }

  topicsOf(project) {
    return Object.entries(this.state.topics)
      .filter(([key, topic]) => {
        if (!topic?.threadId || topic.retired) return false;
        return key.startsWith(`${project}::`) || topic.projectName === project || String(topic.title || "").startsWith(`${project} ·`);
      })
      .map(([, topic]) => topic)
      .sort((a, b) => String(a.title).localeCompare(String(b.title), "pt"));
  }

  entriesOf(project) {
    const byKey = new Map();
    for (const tab of this.tabs()) {
      if (tab.synthetic || tab.ambiguous) continue;
      const name = tab.projectName || tab.key.split("::")[0];
      if (name !== project) continue;
      const topic = this.state.topics[tab.key];
      byKey.set(tab.key, {
        key: tab.key,
        title: topic?.title || tab.title,
        threadId: topic?.threadId || 0,
      });
    }
    for (const [key, topic] of Object.entries(this.state.topics)) {
      if (!topic?.threadId || topic.retired || byKey.has(key)) continue;
      const name = topic.projectName || (String(topic.title || "").startsWith(`${project} ·`) ? project : key.split("::")[0]);
      if (name !== project) continue;
      byKey.set(key, { key, title: topic.title, threadId: topic.threadId });
    }
    return [...byKey.values()].sort((a, b) => String(a.title).localeCompare(String(b.title), "pt"));
  }

  shareRow(project, entry) {
    const name = conversationName(project, entry.title).slice(0, 48);
    const url = entry.threadId ? topicUrl(this.chatId(), entry.threadId) : "";
    if (url) {
      return [
        { text: name, url },
        { text: "Ocultar", callback_data: `o:${shortId(entry.key)}` },
      ];
    }
    return [{ text: `Incluir ${name}`.slice(0, 64), callback_data: `i:${shortId(entry.key)}` }];
  }

  tabButton(tab) {
    const project = tab.projectName || tab.key.split("::")[0] || "Cursor";
    const topic = this.state.topics[tab.key];
    const name = conversationName(project, topic?.title || tab.title);
    const url = topic?.threadId && !topic.retired && !topic.closed
      ? topicUrl(this.chatId(), topic.threadId)
      : "";
    if (url) return { text: name.slice(0, 64), url };
    if (this.sharesSelected() && !tab.ambiguous) {
      return { text: `Incluir ${name}`.slice(0, 64), callback_data: `i:${shortId(tab.key)}` };
    }
    return { text: name.slice(0, 64), callback_data: `n:${shortId(tab.key)}` };
  }

  async showActive(threadId) {
    const seen = new Set();
    const active = [];
    for (const tab of this.tabs()) {
      if (!tab.active || tab.synthetic || tab.ambiguous || !tab.window) continue;
      if (seen.has(tab.window.targetId)) continue;
      seen.add(tab.window.targetId);
      active.push(tab);
    }
    active.sort((a, b) => String(a.projectName).localeCompare(String(b.projectName), "pt"));
    if (!active.length) {
      await this.reply(threadId, "Nenhuma conversa ativa.");
      return;
    }
    const rows = active.map((tab) => {
      const project = tab.projectName || tab.key.split("::")[0] || "Cursor";
      const button = this.tabButton(tab);
      return [{ ...button, text: `${project} · ${button.text}`.slice(0, 64) }];
    });
    await this.reply(threadId, "Conversas ativas. Toque para abrir o tópico.", {
      reply_markup: { inline_keyboard: rows },
    });
  }

  async showProjectHome(threadId, project) {
    if (!this.openProjects().includes(project)) {
      await this.reply(threadId, `${project} não está aberto.`);
      await this.showProjects(threadId);
      return;
    }
    const active = this.tabs().filter((tab) => (
      !tab.synthetic
      && !tab.ambiguous
      && tab.active
      && (tab.projectName || tab.key.split("::")[0]) === project
    ));
    const rows = active.map((tab) => [this.tabButton(tab)]);
    rows.push([{ text: "Ver todas", callback_data: `g:0:${project}` }]);
    rows.push([{ text: "Projetos", callback_data: "m:projetos" }]);
    const head = active.length ? `${project}. Conversa ativa.` : `${project}. Nenhuma conversa ativa.`;
    await this.reply(threadId, head, { reply_markup: { inline_keyboard: rows } });
  }

  async showTabs(threadId) {
    const groups = new Map();
    for (const tab of this.tabs()) {
      if (tab.synthetic) continue;
      const project = tab.projectName || tab.key.split("::")[0] || "Cursor";
      const list = groups.get(project) || [];
      list.push(tab);
      groups.set(project, list);
    }
    if (!groups.size) {
      await this.reply(threadId, "Nenhuma aba visível.");
      return;
    }
    const projects = [...groups.keys()].sort((a, b) => a.localeCompare(b, "pt"));
    for (const project of projects) {
      const rows = groups.get(project)
        .sort((a, b) => String(a.title).localeCompare(String(b.title), "pt"))
        .map((tab) => {
          const topic = this.state.topics[tab.key];
          const name = conversationName(project, topic?.title || tab.title);
          const label = `${tab.active ? `${name} · ativa` : name}`.slice(0, 64);
          const url = topic?.threadId && !topic.retired && !topic.closed
            ? topicUrl(this.chatId(), topic.threadId)
            : "";
          if (url) return [{ text: label, url }];
          if (this.sharesSelected() && !tab.ambiguous) {
            return [{ text: `Incluir ${name}`.slice(0, 64), callback_data: `i:${shortId(tab.key)}` }];
          }
          return [{ text: label, callback_data: `n:${shortId(tab.key)}` }];
        });
      await this.reply(threadId, project, { reply_markup: { inline_keyboard: rows } });
    }
  }

  async showProjects(threadId) {
    const projects = this.openProjects();
    if (!projects.length) {
      await this.reply(threadId, "Nenhum projeto aberto.");
      return;
    }
    await this.reply(threadId, "Projetos abertos. Toque um para ver as conversas.", {
      reply_markup: {
        inline_keyboard: [
          ...projects.map((name) => [{ text: name.slice(0, 64), callback_data: `p:${name}` }]),
          [{ text: "Menu", callback_data: "m:painel" }],
        ],
      },
    });
  }

  async showShareList(threadId, project, page) {
    const entries = this.entriesOf(project);
    if (!entries.length) {
      await this.reply(threadId, `Nenhuma conversa visível de ${project}.`, {
        reply_markup: { inline_keyboard: [[{ text: "Projetos", callback_data: "m:projetos" }]] },
      });
      return;
    }
    const pages = Math.ceil(entries.length / TOPIC_PAGE);
    const current = Math.min(Math.max(page, 0), pages - 1);
    const slice = entries.slice(current * TOPIC_PAGE, (current + 1) * TOPIC_PAGE);
    const nav = [];
    if (current > 0) nav.push({ text: "Anterior", callback_data: `g:${current - 1}:${project}` });
    nav.push({ text: "Projetos", callback_data: "m:projetos" });
    if (current + 1 < pages) nav.push({ text: "Próxima", callback_data: `g:${current + 1}:${project}` });
    const head = pages > 1
      ? `${project}. Página ${current + 1} de ${pages}. Inclua o que quer espelhar.`
      : `${project}. Inclua o que quer espelhar.`;
    await this.reply(threadId, head, {
      reply_markup: { inline_keyboard: [...slice.map((entry) => this.shareRow(project, entry)), nav] },
    });
  }

  async showProjectTopics(threadId, project, page) {
    if (!this.openProjects().includes(project)) {
      await this.reply(threadId, `${project} não está aberto.`);
      await this.showProjects(threadId);
      return;
    }
    if (this.sharesSelected()) {
      await this.showShareList(threadId, project, page);
      return;
    }
    const topics = this.topicsOf(project);
    if (!topics.length) {
      await this.reply(threadId, `Nenhum tópico de ${project} ainda. Use /recarregar no General.`, {
        reply_markup: { inline_keyboard: [[{ text: "Projetos", callback_data: "m:projetos" }]] },
      });
      return;
    }
    const pages = Math.ceil(topics.length / TOPIC_PAGE);
    const current = Math.min(Math.max(page, 0), pages - 1);
    const slice = topics.slice(current * TOPIC_PAGE, (current + 1) * TOPIC_PAGE);
    const nav = [];
    if (current > 0) nav.push({ text: "Anterior", callback_data: `g:${current - 1}:${project}` });
    nav.push({ text: "Projetos", callback_data: "m:projetos" });
    if (current + 1 < pages) nav.push({ text: "Próxima", callback_data: `g:${current + 1}:${project}` });
    const head = pages > 1 ? `${project}. Página ${current + 1} de ${pages}.` : `${project}. Toque para abrir o tópico.`;
    await this.reply(threadId, head, {
      reply_markup: {
        inline_keyboard: [
          ...slice.map((topic) => [{
            text: conversationName(project, topic.title).slice(0, 64),
            url: topicUrl(this.chatId(), topic.threadId),
          }]),
          nav,
        ],
      },
    });
  }

  async createSharedTopic(tab) {
    const chatId = this.chatId();
    const existingKey = findExistingTopic(this.state.topics, tab);
    if (existingKey) {
      this.moveTopic(existingKey, tab.key, tab.window.targetId);
      return this.state.topics[tab.key];
    }
    const topic = await this.telegram.createForumTopic(chatId, tab.title);
    this.state.forum = true;
    this.state.topics[tab.key] = {
      threadId: topic.message_thread_id,
      title: tab.title,
      targetId: tab.window.targetId,
      stableId: tab.stableId || "",
      projectName: tab.projectName || "",
      workspacePath: tab.workspacePath || "",
      closed: false,
      ambiguous: false,
      retired: false,
    };
    await this.persist();
    await this.telegram.sendText(
      chatId,
      "Aba ligada. Escreva aqui para falar com este agente.",
      { message_thread_id: topic.message_thread_id },
    );
    return this.state.topics[tab.key];
  }

  async includeTab(threadId, key) {
    if (!this.sharesSelected()) {
      await this.reply(threadId, "O modo atual já compartilha todas as abas.");
      return;
    }
    const tab = this.tabs().find((item) => item.key === key);
    if (!tab || tab.synthetic || tab.ambiguous || !tab.window) {
      await this.reply(threadId, "Essa conversa não está visível na barra lateral.");
      return;
    }
    this.state.shared ||= {};
    this.state.shared[key] = true;
    try {
      await this.createSharedTopic(tab);
      await this.persist();
    } catch (error) {
      await this.reply(threadId, `Não consegui abrir o tópico: ${error.message}`);
      return;
    }
    await this.showShareList(threadId, tab.projectName || key.split("::")[0], 0);
  }

  async hideTab(threadId, key, { refresh = false } = {}) {
    if (!this.sharesSelected()) {
      await this.reply(threadId, "O modo atual compartilha todas as abas. Defina COMPARTILHAR=escolhidas no .env e reinicie a ponte.");
      return;
    }
    const title = this.state.topics[key]?.title || this.tabs().find((tab) => tab.key === key)?.title || key;
    const removed = await this.forgetTopic(this.chatId(), key);
    if (!removed) {
      await this.reply(threadId, "Não consegui apagar o tópico.");
      return;
    }
    if (this.state.shared) delete this.state.shared[key];
    await this.persist();
    await this.reply(1, `Oculta: ${title}`);
    if (refresh) await this.showShareList(threadId, key.split("::")[0], 0);
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
      if (this.state.history?.[oldKey] && !this.state.history[newKey]) {
        this.state.history[newKey] = this.state.history[oldKey];
      }
      delete this.state.history?.[oldKey];
      if (this.state.progress?.[oldKey] && !this.state.progress[newKey]) {
        this.state.progress[newKey] = this.state.progress[oldKey];
      }
      delete this.state.progress?.[oldKey];
      if (this.state.approvals?.[oldKey] && !this.state.approvals[newKey]) {
        this.state.approvals[newKey] = this.state.approvals[oldKey];
      }
      delete this.state.approvals?.[oldKey];
      for (const token of Object.values(this.state.approvalTokens || {})) {
        if (token?.key === oldKey) token.key = newKey;
      }
      return;
    }
    this.state.topics[newKey].targetId = targetId;
  }

  retireDuplicates(tab, keepKey) {
    for (const [key, topic] of Object.entries(this.state.topics)) {
      if (key === keepKey || !topic || topic.retired) continue;
      const sameStable = tab.stableId && topic.stableId === tab.stableId;
      const sameTitle = topic.title === tab.title && sameProjectLoose(topic, tab);
      if (sameStable || sameTitle) topic.retired = true;
    }
  }

  canUnlink(topic) {
    if (!this.windows.length) return false;
    const readable = this.windows.filter((window) => !window.error);
    if (!readable.length) return false;
    if (topic.targetId) {
      const listed = this.windows.find((window) => window.targetId === topic.targetId);
      if (listed?.error || listed?.tabsIncomplete || listed?.listReliable === false) return false;
      return true;
    }
    return !readable.some((window) => window.tabsIncomplete || window.listReliable === false);
  }

  unlinkMissing() {
    const live = new Set(this.tabs().filter((tab) => !tab.synthetic).map((tab) => tab.key));
    const liveTitles = new Set(this.tabs().filter((tab) => !tab.synthetic).map((tab) => tab.title));
    for (const [key, topic] of Object.entries(this.state.topics)) {
      if (!topic || topic.retired || topic.closed) continue;
      if (live.has(key) || liveTitles.has(topic.title)) continue;
      if (!this.canUnlink(topic)) continue;
      topic.closed = true;
    }
  }

  markAmbiguousProjects() {
    annotateWindows(this.windows);
    const names = new Set(this.windows.filter((window) => window.projectAmbiguous).map((window) => window.projectName));
    if (!names.size) return;
    for (const [key, topic] of Object.entries(this.state.topics)) {
      if (!topic || topic.workspacePath) continue;
      const prefix = key.split("::")[0];
      if (names.has(prefix) || names.has(topic.projectName)) topic.ambiguous = true;
    }
    for (const name of names) {
      if (this.state.ambiguityNotified?.[name]) continue;
      this.state.ambiguityNotified[name] = Date.now();
      this.pendingNotices.push(`Há mais de um projeto chamado "${name}" sem caminho distinto. Não vou escolher o destino.`);
    }
  }

  async syncTopics({ unlink = false } = {}) {
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
        this.logEvent("telegram", { event: "get_chat", error: error.message });
        return;
      }
      if (!this.state.forum) return;
    }
    this.markAmbiguousProjects();
    if (unlink) this.unlinkMissing();
    for (const tab of this.tabs()) {
      if (tab.synthetic || tab.ambiguous) continue;
      const existingKey = findExistingTopic(this.state.topics, tab);
      if (existingKey) {
        this.moveTopic(existingKey, tab.key, tab.window.targetId);
        this.retireDuplicates(tab, tab.key);
        const known = this.state.topics[tab.key];
        known.closed = false;
        known.ambiguous = false;
        known.stableId = tab.stableId || known.stableId || "";
        known.projectName = tab.projectName || known.projectName || "";
        known.workspacePath = tab.workspacePath || known.workspacePath || "";
        known.targetId = tab.window.targetId;
        if (known.title !== tab.title) {
          try {
            await this.telegram.editForumTopic(chatId, known.threadId, tab.title);
          } catch (error) {
            this.logEvent("telegram", { event: "rename_topic", error: error.message, dest: tab.key });
          }
          known.title = tab.title;
        }
        continue;
      }
      if (this.sharesSelected() && !this.state.shared?.[tab.key]) continue;
      try {
        const topic = await this.telegram.createForumTopic(chatId, tab.title);
        this.state.forum = true;
        this.state.topics[tab.key] = {
          threadId: topic.message_thread_id,
          title: tab.title,
          targetId: tab.window.targetId,
          stableId: tab.stableId || "",
          projectName: tab.projectName || "",
          workspacePath: tab.workspacePath || "",
          closed: false,
          ambiguous: false,
          retired: false,
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
        this.logEvent("telegram", { event: "create_topic", error: error.message, dest: tab.key });
      }
    }
  }

  rememberHistory(key, messages, { truncated = false } = {}) {
    const trimmed = (messages || []).filter((message) => message?.text).slice(-40).map((message) => ({
      id: message.id || "",
      role: message.role || "",
      text: String(message.text).slice(0, 20000),
      truncated: Boolean(message.truncated),
    }));
    const truncatedFlag = Boolean(truncated);
    const current = this.state.history[key];
    if (current && current.truncated === truncatedFlag && JSON.stringify(current.messages) === JSON.stringify(trimmed)) return;
    this.state.history[key] = { messages: trimmed, updatedAt: Date.now(), truncated: truncatedFlag };
  }

  rememberPrompt(key, text) {
    const own = this.state.ownPrompts[key] || [];
    own.push(text);
    this.state.ownPrompts[key] = own.slice(-20);
  }

  async deliverTracked(chatId, text, extra, trackingId) {
    const parts = chunkText(text);
    let record = this.state.outbound[trackingId];
    if (!record?.parts?.length) {
      record = { parts: parts.map((part) => ({ text: part, status: "pendente", messageId: null })) };
      this.state.outbound[trackingId] = record;
    }
    const send = this.telegram.sendExact
      ? (part, options) => this.telegram.sendExact(chatId, part, options)
      : (part, options) => this.telegram.sendText(chatId, part, options);
    for (const part of record.parts) {
      if (part.status === "confirmada") continue;
      const sent = await send(part.text, extra);
      part.status = "confirmada";
      part.messageId = sent?.message_id || null;
      await this.persist();
    }
    delete this.state.outbound[trackingId];
  }

  async publish() {
    const chatId = this.chatId();
    if (!chatId) return;
    for (const tab of this.tabs()) {
      if (!tab.active) continue;
      const key = tab.key;
      this.rememberHistory(key, tab.window.messages || [], { truncated: tab.window.historyTruncated });
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
        const note = item.truncated ? "\n\n[O Cursor só mostrou parte desta mensagem.]" : "";
        await this.deliverTracked(chatId, `${prefix}${item.text}${note}`, extra, item.hash);
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
          if (!/not modified/i.test(error.message)) this.logEvent("telegram", { event: "progress", error: error.message, dest: key });
        }
      } else if (!planned.progress && progress.messageId) {
        try {
          await this.telegram.deleteMessage(chatId, progress.messageId);
        } catch (error) {
          if (!/not found|can't be deleted|message to delete/i.test(error.message)) {
            this.logEvent("telegram", { event: "progress", error: error.message, dest: key });
          }
        }
        progress.messageId = null;
        progress.text = "";
      }
      this.state.progress[key] = progress;
      await this.publishApproval(tab, chatId, extra);
    }
    await this.syncIcons();
  }

  async publishApproval(tab, chatId, extra) {
    const key = tab.key;
    const approval = tab.window.approvals?.[0];
    const hash = approval ? approvalHash(approval) : "";
    const currentId = typeof this.state.approvals?.[key] === "string" ? this.state.approvals[key] : "";
    const current = currentId ? this.state.approvalTokens?.[currentId] : null;
    if (!approval) {
      if (current?.status === "pending") current.status = "invalid";
      this.state.approvals[key] = "";
      return;
    }
    if (current && current.hash === hash && ["pending", "em_execucao", "consumed", "uncertain"].includes(current.status)) return;
    if (current?.status === "pending") current.status = "invalid";
    const token = createApprovalToken({
      key,
      approval,
      threadId: this.state.topics[key]?.threadId || 0,
      chatId,
      project: tab.projectName || key.split("::")[0],
      conversation: tab.tab?.title || tab.title,
    });
    this.state.approvalTokens[token.id] = token;
    this.state.approvals[key] = token.id;
    await this.telegram.sendText(
      chatId,
      [
        "Aprovar este passo?",
        `Projeto: ${token.project}`,
        `Conversa: ${token.conversation}`,
        token.command || token.label,
      ].join("\n"),
      {
        ...extra,
        reply_markup: {
          inline_keyboard: [[
            { text: "Aprovar", callback_data: `a:${token.id}` },
            { text: "Recusar", callback_data: `r:${token.id}` },
          ]],
        },
      },
    );
  }

  async syncIcons() {
    const chatId = this.chatId();
    if (!chatId || this.state.forum === false) return;
    for (const tab of this.tabs()) {
      const topic = this.state.topics[tab.key];
      if (!topic?.threadId || topic.closed || topic.retired) continue;
      const mode = tab.active && topicIcons[tab.window.status] ? tab.window.status : "idle";
      if (topic.icon === mode) continue;
      try {
        await this.telegram.setForumTopicIcon(chatId, topic.threadId, topicIcons[mode]);
        topic.icon = mode;
      } catch (error) {
        if (!/not modified/i.test(error.message)) this.logEvent("telegram", { event: "icon", error: error.message, dest: tab.key });
      }
    }
  }

  async syncOnce() {
    return this.exclusive(() => this.syncBody());
  }

  async syncBody() {
    const notes = reconcileOperations(this.state.operations, Date.now(), process.pid);
    const tokenNotes = reconcileTokens(this.state.approvalTokens, Date.now(), process.pid);
    try {
      this.windows = await this.cursor.windows();
      this.state.lastCursorReadAt = Date.now();
      this.noteSelectors();
      const wasDown = this.state.cdpDownNotified;
      this.state.cdpDownNotified = false;
      if (wasDown) this.pendingNotices.push("Voltei a ver o Cursor.");
    } catch (error) {
      this.windows = [];
      this.state.lastError = `Cursor: ${error.message}`;
      this.logEvent("cursor", { event: "down", error: error.message });
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
    await this.runPending();
    await this.notifyReconciled(notes, tokenNotes);
    pruneHistory(this.state, { liveKeys: this.tabs().map((tab) => tab.key) });
    await this.flushNotices();
    await this.persist();
  }

  noteSelectors() {
    const readable = this.windows.filter((window) => !window.error);
    if (!readable.length) return;
    if (!readable.every((window) => selectorsBroken(window))) {
      this.selectorMisses = 0;
      if (this.state.selectorsBrokenNotified) {
        this.state.selectorsBrokenNotified = false;
        this.pendingNotices.push("Voltei a ler a interface do Cursor.");
      }
      return;
    }
    this.selectorMisses += 1;
    if (this.selectorMisses < 2 || this.state.selectorsBrokenNotified) return;
    this.state.selectorsBrokenNotified = true;
    this.pendingNotices.push("A leitura do Cursor perdeu os seletores da interface. Uma atualização do editor pode ter mudado a tela. Rode npm run probe e confira selectors.json.");
  }

  async flushNotices() {
    const notices = this.pendingNotices.splice(0);
    if (!this.chatId()) return;
    for (const text of notices) {
      try {
        await this.telegram.sendText(this.chatId(), text);
      } catch (error) {
        this.logEvent("telegram", { event: "notice_failed", error: error.message });
      }
    }
  }

  async notifyReconciled(notes, tokenNotes) {
    for (const op of notes) {
      if (op.notified || op.status !== "resultado_incerto") continue;
      op.notified = true;
      await this.reply(op.threadId, `Resultado incerto em ${op.destination || "uma conversa"}. A ação foi interrompida e não vou repeti-la.`);
    }
    for (const token of tokenNotes) {
      if (token.status !== "uncertain" || token.notified) continue;
      token.notified = true;
      await this.reply(token.threadId, "Resultado incerto numa aprovação. Não repeti o clique.");
    }
  }

  async ensureMenu() {
    const chatId = this.chatId();
    if (!chatId || this.state.forum === false) return;
    const text = menuText(this.sharesSelected());
    const markup = menuMarkup();
    if (this.state.menuMessageId && this.state.menuVersion === MENU_VERSION) return;
    if (this.state.menuMessageId) {
      try {
        await this.telegram.editMessage(chatId, this.state.menuMessageId, text, markup);
        this.state.menuVersion = MENU_VERSION;
        return;
      } catch (error) {
        if (/not modified/i.test(error.message)) {
          this.state.menuVersion = MENU_VERSION;
          return;
        }
        this.logEvent("telegram", { event: "edit_menu", error: error.message });
        this.state.menuMessageId = null;
      }
    }
    const sent = await this.reply(1, text, { reply_markup: markup });
    this.state.menuMessageId = sent?.message_id || null;
    this.state.menuVersion = MENU_VERSION;
    if (!this.state.menuMessageId) return;
    try {
      await this.telegram.pinChatMessage(chatId, this.state.menuMessageId);
    } catch (error) {
      this.logEvent("telegram", { event: "pin_menu", error: error.message });
    }
  }

  makeOp({ updateId, kind, threadId, text = "", destination = "" }) {
    const now = Date.now();
    return {
      id: operationId(updateId, kind, destination || threadId || "general"),
      updateId,
      kind,
      threadId: threadId || 0,
      text,
      destination: destination || "",
      status: "recebida",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + OPERATION_TTL_MS,
      error: "",
      announced: false,
      notified: false,
      ownerPid: 0,
    };
  }

  async acceptUpdate(update, buildOp) {
    if (update.update_id == null) return { ok: true };
    if (update.update_id < (this.state.updateOffset || 0)) return { ok: true, duplicate: true };
    const draft = buildOp ? buildOp() : null;
    let full = false;
    let duplicate = false;
    try {
      await this.stage(() => {
        this.state.updateOffset = update.update_id + 1;
        if (!draft) return;
        const admitted = admitOperation(this.state.operations || [], draft, Date.now());
        this.state.operations = admitted.operations;
        full = admitted.full;
        duplicate = admitted.duplicate;
      });
    } catch (error) {
      this.state.lastError = `persistência: ${error.message}`;
      this.logEvent("state", { event: "persist_failed", error: error.message, op: draft?.id || "" });
      return { ok: false, error };
    }
    if (!draft) return { ok: true };
    const operation = (this.state.operations || []).find((item) => item.id === draft.id) || null;
    return { ok: true, operation, full, duplicate };
  }

  async handleUpdate(update) {
    if (!this.intakeOpen) return null;
    return this.exclusive(() => this.applyUpdate(update));
  }

  async applyUpdate(update) {
    if (update.callback_query) {
      const accepted = await this.acceptUpdate(update, null);
      if (!accepted.ok || accepted.duplicate) return;
      await this.handleCallback(update.callback_query, update.update_id);
      return;
    }
    const message = update.message;
    if (!message || message.from?.is_bot) {
      await this.acceptUpdate(update, null);
      return;
    }
    const userId = message.from?.id;
    if (userId == null) {
      await this.acceptUpdate(update, null);
      return;
    }
    const text = message.text || "";
    const command = commandOf(text);
    const threadId = message.message_thread_id || 0;
    const chatId = String(message.chat.id);
    if (command?.name === "parear") {
      const accepted = await this.acceptUpdate(update, null);
      if (!accepted.ok || accepted.duplicate) return;
      await this.pair(command.arg, userId, chatId, threadId);
      return;
    }
    const expected = this.authorizedUser();
    if (!expected || String(userId) !== expected) {
      await this.acceptUpdate(update, null);
      return;
    }
    const configuredChat = this.chatId();
    if (!configuredChat || chatId !== configuredChat) {
      await this.acceptUpdate(update, null);
      if (!configuredChat) {
        await this.reply(threadId, "O grupo ainda não está pareado. Envie /parear com o código do terminal.");
      }
      return;
    }
    if (command?.name === "parar") {
      if (!threadId || threadId === 1) {
        const accepted = await this.acceptUpdate(update, null);
        if (!accepted.ok || accepted.duplicate) return;
        await this.reply(threadId || 1, "Use /parar dentro do tópico da conversa.");
        return;
      }
      const accepted = await this.acceptUpdate(update, () => this.makeOp({
        updateId: update.update_id,
        kind: "stop",
        threadId,
      }));
      if (!accepted.ok || (accepted.duplicate && !isRunnable(accepted.operation))) return;
      if (accepted.full) {
        await this.reply(threadId, "A fila está cheia. Espere os pedidos pendentes terminarem.");
        return;
      }
      await this.executeOperation(accepted.operation);
      return;
    }
    if (command) {
      const accepted = await this.acceptUpdate(update, null);
      if (!accepted.ok || accepted.duplicate) return;
      await this.handleCommand(command, threadId);
      return;
    }
    if (!text.trim()) {
      await this.acceptUpdate(update, null);
      return;
    }
    const accepted = await this.acceptUpdate(update, () => this.makeOp({
      updateId: update.update_id,
      kind: "prompt",
      threadId,
      text: text.trim(),
    }));
    if (!accepted.ok) {
      await this.reply(threadId, "Não registrei este pedido. Envie de novo.");
      return;
    }
    if (accepted.duplicate && !isRunnable(accepted.operation)) return;
    if (accepted.full) {
      await this.reply(threadId, "A fila está cheia. Espere os pedidos pendentes terminarem.");
      return;
    }
    await this.executeOperation(accepted.operation);
  }

  async runPending() {
    const pending = (this.state.operations || []).filter((op) => isRunnable(op));
    for (const op of pending) await this.executeOperation(op);
  }

  async executeOperation(op) {
    if (!op || !isRunnable(op)) return;
    const purpose = op.kind === "stop" ? "stop" : "prompt";
    const dest = this.destination(op.threadId, purpose);
    if (!dest.ok) {
      op.status = "falhou";
      op.error = dest.reason;
      op.updatedAt = Date.now();
      await this.persist().catch((error) => {
        this.state.lastError = `persistência: ${error.message}`;
      });
      const extra = dest.reason === "general" ? { reply_markup: menuMarkup() } : {};
      await this.reply(op.threadId, dest.message, extra);
      return;
    }
    op.destination = dest.key;
    op.status = "em_execucao";
    op.ownerPid = process.pid;
    op.attempts = (op.attempts || 0) + 1;
    op.updatedAt = Date.now();
    try {
      await this.persist();
    } catch (error) {
      op.status = "pendente";
      op.ownerPid = 0;
      this.state.lastError = `persistência: ${error.message}`;
      await this.reply(op.threadId, "Não consegui registrar a execução. O pedido continua pendente.");
      return;
    }
    if (op.kind === "stop") await this.finishStop(op, dest);
    else await this.finishPrompt(op, dest);
  }

  async finishPrompt(op, dest) {
    const title = dest.tab.tab?.title || "";
    const targetId = dest.tab.window?.targetId;
    if (!op.announced) {
      op.announced = true;
      await this.persist().catch(() => {});
      await this.reply(op.threadId, "Recebido pela ponte. Aguardando envio.");
    }
    try {
      await this.cursor.prepareConversation(targetId, title);
      const surface = await this.cursor.readSurface(targetId);
      if (!this.titleMatches(surface, title)) {
        throw Object.assign(new Error(`Não confirmei a conversa "${title}". A janela está em "${surface?.title || "desconhecida"}".`), { beforeEffect: true });
      }
      if (String(surface?.composer || "").trim()) {
        throw Object.assign(new Error("Há um rascunho nesta conversa. Não enviei o prompt e não apaguei o texto."), { beforeEffect: true, draft: true });
      }
      await this.cursor.submitPrompt(targetId, op.text);
      const seen = await this.cursor.observePrompt(targetId, op.text);
      const after = await this.cursor.readSurface(targetId);
      const seenTitleOk = !seen?.title || this.titleMatches({ title: seen.title }, title);
      if (!seen?.ok || !this.titleMatches(after, title) || !seenTitleOk) {
        op.status = "resultado_incerto";
        op.error = seen?.ok ? "A conversa mudou durante o envio." : "Não vi o prompt na conversa.";
        op.updatedAt = Date.now();
        await this.persist().catch(() => {});
        await this.reply(op.threadId, "Resultado incerto. Não confirmei o recebimento na conversa certa e não vou reenviar sozinho.");
        return;
      }
      this.rememberPrompt(dest.key, op.text);
      this.rememberHistory(dest.key, after.messages || []);
      op.status = "confirmada";
      op.error = "";
      op.updatedAt = Date.now();
      await this.persist().catch(() => {});
      await this.reply(op.threadId, "Recebido pelo Cursor.");
    } catch (error) {
      op.updatedAt = Date.now();
      op.error = error.message;
      op.status = error.beforeEffect ? "falhou" : "resultado_incerto";
      await this.persist().catch(() => {});
      if (error.beforeEffect) {
        await this.reply(op.threadId, error.message);
        return;
      }
      await this.reply(op.threadId, `Resultado incerto. ${error.message} Não vou reenviar sozinho.`);
    }
  }

  async finishStop(op, dest) {
    const title = dest.tab.tab?.title || dest.tab.title;
    const targetId = dest.tab.window.targetId;
    try {
      if (dest.scope === "current_window") {
        const surface = await this.cursor.readSurface(targetId);
        await this.cursor.clickKind(targetId, "stop");
        op.status = "confirmada";
        op.updatedAt = Date.now();
        await this.persist().catch(() => {});
        await this.reply(op.threadId, `Pedido de parada enviado na janela atual: ${surface?.title || title}.`);
        return;
      }
      await this.cursor.prepareConversation(targetId, title);
      const surface = await this.cursor.readSurface(targetId);
      if (!this.titleMatches(surface, title)) {
        throw Object.assign(new Error(`Não confirmei a conversa "${title}". A janela está em "${surface?.title || "desconhecida"}".`), { beforeEffect: true });
      }
      await this.cursor.clickKind(targetId, "stop");
      op.status = "confirmada";
      op.updatedAt = Date.now();
      await this.persist().catch(() => {});
      await this.reply(op.threadId, `Pedido de parada enviado em ${dest.tab.title}.`);
    } catch (error) {
      op.error = error.message;
      op.status = error.beforeEffect ? "falhou" : "resultado_incerto";
      op.updatedAt = Date.now();
      await this.persist().catch(() => {});
      const prefix = op.status === "resultado_incerto" ? "Resultado incerto. " : "";
      await this.reply(op.threadId, `${prefix}${error.message}`);
    }
  }

  async handleCommand(command, threadId) {
    if (command.name === "menu") {
      this.state.menuMessageId = null;
      await this.ensureMenu();
      return;
    }
    if (command.name === "diagnostico") {
      await this.reply(threadId, await this.diagnosticText());
      return;
    }
    if (command.name === "start" || command.name === "ajuda" || command.name === "help") {
      await this.reply(threadId, helpText, { reply_markup: menuMarkup() });
      return;
    }
    if (command.name === "status") {
      const lines = [
        `Chat ${this.chatId() || "ainda não definido"}`,
        `Tópicos: ${this.state.forum === false ? "não" : "sim"}`,
        `Compartilhar: ${this.sharesSelected() ? "escolhidas" : "todas"}`,
        `Janelas visíveis: ${this.windows.filter((window) => !window.error).length}`,
        `Fila: ${this.queueSummary()}`,
      ];
      if (this.state.lastCursorReadAt) {
        const age = Math.max(0, Math.round((Date.now() - this.state.lastCursorReadAt) / 1000));
        lines.push(`Última leitura: há ${age}s`);
      }
      if (!this.windows.length) lines.push("Porta 9222 sem janelas. Abra o Cursor com bin/cursor-debug.");
      else lines.push(...this.windows.map((window) => `• ${window.title} (${window.status || "?"})`));
      if (this.state.lastError) lines.push(`Último erro: ${String(this.state.lastError).slice(0, 180)}`);
      await this.reply(threadId, lines.join("\n"));
      return;
    }
    if (command.name === "abas" || command.name === "usar") {
      const tabs = this.tabs();
      if (command.name === "usar") {
        if (this.state.forum !== false) {
          await this.reply(threadId, "Com tópicos, escreva no tópico da conversa. /usar vale quando o grupo não tem tópicos.");
          return;
        }
        const chosen = tabs[Number(command.arg) - 1];
        if (!chosen || chosen.ambiguous) {
          await this.reply(threadId, chosen?.ambiguous
            ? "Essa conversa está ambígua. Não vou escolhê-la."
            : "Número inválido. /abas mostra a lista.");
          return;
        }
        this.state.activeTabKey = chosen.key;
        await this.reply(threadId, `Usando ${chosen.title}`);
        return;
      }
      if (this.state.forum !== false) {
        await this.showTabs(threadId);
        return;
      }
      await this.reply(threadId, tabs.length
        ? tabs.map((tab, index) => `${index + 1}. ${tab.title}${tab.active ? " (ativa)" : ""}${tab.ambiguous ? " (ambígua)" : ""}`).join("\n")
        : "Nenhuma aba visível.");
      return;
    }
    if (command.name === "recarregar" || command.name === "reload") {
      if (this.state.forum !== false && threadId && threadId !== 1) {
        await this.reply(threadId, "Use /recarregar no General.");
        return;
      }
      if (this.sharesSelected()) {
        await this.confirmReload(threadId);
        return;
      }
      let skipped = false;
      try {
        this.windows = await this.cursor.windows();
        this.state.lastCursorReadAt = Date.now();
        if (!this.windows.some((window) => !window.error)) skipped = true;
        else await this.syncTopics({ unlink: true });
        await this.persist();
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
        ? `Abas recarregadas (${tabs.length}). O histórico dos tópicos foi mantido.\n${tabs.map((tab, index) => `${index + 1}. ${tab.title}${tab.active ? " (ativa)" : ""}`).join("\n")}`
        : "Nenhuma aba visível. O histórico dos tópicos foi mantido.");
      return;
    }
    if (command.name === "painel") {
      await this.reply(threadId, "Atalhos.", { reply_markup: menuMarkup() });
      return;
    }
    if (command.name === "projetos") {
      await this.showProjects(threadId);
      return;
    }
    if (command.name === "ativas") {
      await this.showActive(threadId);
      return;
    }
    if (command.name === "ocultar") {
      const entry = Object.entries(this.state.topics).find(([, topic]) => topic?.threadId === threadId);
      if (!entry) {
        await this.reply(threadId, "Use /ocultar dentro do tópico da conversa.");
        return;
      }
      await this.hideTab(threadId, entry[0]);
      return;
    }
    if (command.name === "ultimo" || command.name === "limpar") {
      await this.handleHistory(command, threadId);
      return;
    }
    if (command.name === "esquecer") {
      await this.askForget(threadId);
      return;
    }
    if (command.name === "tela") {
      await this.handleScreenshot(threadId);
    }
  }

  queueSummary() {
    const ops = this.state.operations || [];
    const pending = ops.filter((op) => op.status === "pendente" || op.status === "recebida").length;
    const uncertain = ops.filter((op) => op.status === "resultado_incerto").length;
    const failed = ops.filter((op) => op.status === "falhou").length;
    return `${pending} pendente(s), ${failed} falha(s), ${uncertain} incerto(s)`;
  }

  async diagnosticText() {
    let permissions = null;
    try {
      if (this.telegram.getMe && this.chatId()) {
        const me = await this.telegram.getMe();
        if (me?.id && this.telegram.getChatMember) {
          const member = await this.telegram.getChatMember(this.chatId(), me.id);
          permissions = { canManageTopics: Boolean(member?.can_manage_topics || member?.status === "creator") };
        }
      }
    } catch (error) {
      this.state.lastError = `diagnóstico: ${error.message}`;
    }
    return diagnosticReport({
      config: this.config,
      state: this.state,
      windows: this.windows,
      permissions,
    });
  }

  async handleHistory(command, threadId) {
    const dest = this.destination(threadId, "history");
    if (!dest.ok) {
      await this.reply(threadId, dest.message);
      return;
    }
    if (command.name === "limpar") {
      this.state.history[dest.key] = { messages: [], updatedAt: Date.now(), truncated: false };
      await this.reply(threadId, "Apaguei o histórico local desta conversa. As mensagens do Telegram continuam no tópico.");
      return;
    }
    const count = Math.min(Number(command.arg) || 5, 20);
    let source = [];
    let note = "";
    if (dest.tab.active && dest.tab.window) {
      source = dest.tab.window.messages || [];
      this.rememberHistory(dest.key, source, { truncated: dest.tab.window.historyTruncated });
      if (dest.scope === "current_window") note = "Histórico da conversa visível nesta janela.";
      if (dest.tab.window.historyTruncated) note = `${note}\nO Cursor só deixou parte do histórico na tela.`.trim();
    } else {
      const stored = this.state.history?.[dest.key];
      if (!stored?.messages?.length) {
        await this.reply(threadId, "Não tenho o histórico desta conversa. Só leio a conversa que está visível, e não vou mostrar a de outra aba.");
        return;
      }
      source = stored.messages;
      note = "Histórico da última vez em que esta conversa esteve visível. Ela não está na tela agora.";
      if (stored.truncated) note += "\nO Cursor só deixou parte do histórico na tela.";
    }
    const messages = source.filter((message) => message.text).slice(-count);
    if (!messages.length) {
      await this.reply(threadId, "Sem mensagens nesta conversa.");
      return;
    }
    if (note) await this.reply(threadId, note);
    for (const message of messages) {
      const prefix = message.role === "human" ? "Você: " : "";
      const suffix = message.truncated ? "\n\n[O Cursor só mostrou parte desta mensagem.]" : "";
      await this.reply(threadId, `${prefix}${message.text}${suffix}`);
    }
  }

  async handleScreenshot(threadId) {
    if (!threadId || threadId === 1) {
      await this.reply(threadId || 1, "Use /tela dentro do tópico da conversa.");
      return;
    }
    const dest = this.destination(threadId, "screenshot");
    if (!dest.ok) {
      await this.reply(threadId, dest.message);
      return;
    }
    const targetId = dest.tab.window?.targetId;
    try {
      let caption = dest.tab.title;
      if (dest.scope === "current_window") {
        const surface = await this.cursor.readSurface(targetId);
        caption = `Janela atual: ${surface?.title || dest.tab.tab?.title || dest.tab.title}`;
      } else {
        const title = dest.tab.tab?.title || "";
        await this.cursor.prepareConversation(targetId, title);
        const surface = await this.cursor.readSurface(targetId);
        if (!this.titleMatches(surface, title)) {
          throw new Error(`Não confirmei a conversa "${title}". A janela está em "${surface?.title || "desconhecida"}".`);
        }
      }
      const png = await this.cursor.screenshot(targetId);
      await this.postToThread(threadId, (chatId, thread) =>
        this.telegram.sendPhoto(chatId, png, { ...thread, caption }));
    } catch (error) {
      await this.reply(threadId, `Não consegui capturar a tela: ${error.message}`);
    }
  }

  async askForget(threadId) {
    if (!threadId || threadId === 1) {
      await this.reply(threadId, "Use /esquecer dentro do tópico que você quer apagar.");
      return;
    }
    const entry = Object.entries(this.state.topics).find(([, topic]) => topic.threadId === threadId);
    if (!entry) {
      await this.reply(threadId, "Este tópico não está ligado a uma conversa.");
      return;
    }
    const token = randomBytes(4).toString("hex");
    this.state.forgetTokens[token] = {
      key: entry[0],
      threadId,
      title: entry[1].title,
      expiresAt: Date.now() + 2 * 60 * 1000,
    };
    await this.reply(threadId, `Apagar o tópico "${entry[1].title}" e todo o histórico dele no Telegram?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "Apagar histórico", callback_data: `e:${token}` },
          { text: "Cancelar", callback_data: `e:x:${token}` },
        ]],
      },
    });
  }

  async handleCallback(query, updateId) {
    const expectedUser = this.authorizedUser();
    const expectedChat = this.chatId();
    const chatId = String(query.message?.chat?.id || "");
    if (!expectedUser || String(query.from?.id) !== expectedUser || !chatId || chatId !== expectedChat) {
      await this.telegram.answerCallback(query.id, "Sem permissão");
      return;
    }
    const data = query.data || "";
    if (data.startsWith("m:")) {
      const name = data.slice(2);
      const threadId = query.message?.message_thread_id || 1;
      await this.telegram.answerCallback(query.id, "");
      if (name === "parar") {
        if (!threadId || threadId === 1) {
          await this.reply(threadId || 1, "Use /parar dentro do tópico da conversa.");
          return;
        }
        const op = this.makeOp({ updateId, kind: "stop", threadId, destination: `menu:${threadId}` });
        const admitted = admitOperation(this.state.operations || [], op, Date.now());
        this.state.operations = admitted.operations;
        if (admitted.full) {
          await this.reply(threadId, "A fila está cheia. Espere os pedidos pendentes terminarem.");
          return;
        }
        try {
          await this.persist();
        } catch (error) {
          this.state.lastError = `persistência: ${error.message}`;
          await this.reply(threadId, "Não registrei este pedido. Toque de novo.");
          return;
        }
        const stored = (this.state.operations || []).find((item) => item.id === op.id) || admitted.operation;
        if (isRunnable(stored)) await this.executeOperation(stored);
        return;
      }
      await this.handleCommand({ name, arg: "" }, threadId);
      return;
    }
    if (data.startsWith("p:")) {
      const threadId = query.message?.message_thread_id || 1;
      await this.telegram.answerCallback(query.id, "");
      await this.showProjectHome(threadId, data.slice(2));
      return;
    }
    if (data.startsWith("c:")) {
      const threadId = query.message?.message_thread_id || 1;
      await this.telegram.answerCallback(query.id, "");
      if (data === "c:cancelar") {
        await this.reply(threadId, "Cancelado.");
        return;
      }
      if (data === "c:limpar") {
        await this.reloadChosen(threadId);
        return;
      }
      return;
    }
    if (data.startsWith("g:")) {
      const threadId = query.message?.message_thread_id || 1;
      const match = /^g:(\d+):(.*)$/.exec(data);
      await this.telegram.answerCallback(query.id, "");
      if (!match) return;
      await this.showProjectTopics(threadId, match[2], Number(match[1]));
      return;
    }
    if (data.startsWith("i:") || data.startsWith("o:")) {
      const threadId = query.message?.message_thread_id || 1;
      const key = this.keyByShort(data.slice(2));
      await this.telegram.answerCallback(query.id, "");
      if (!key) {
        await this.reply(threadId, "Não achei essa conversa.");
        return;
      }
      if (data.startsWith("i:")) await this.includeTab(threadId, key);
      else await this.hideTab(threadId, key, { refresh: true });
      return;
    }
    if (data.startsWith("n:")) {
      await this.telegram.answerCallback(query.id, "Essa conversa ainda não tem tópico.");
      return;
    }
    if (data.startsWith("e:")) {
      await this.handleForgetCallback(query, data);
      return;
    }
    const kind = data.startsWith("a:") ? "approve" : data.startsWith("r:") ? "reject" : "";
    const token = this.state.approvalTokens?.[data.slice(2)];
    const verdict = judgeCallback({
      token,
      userId: query.from?.id,
      expectedUserId: expectedUser,
      chatId,
      expectedChatId: expectedChat,
    });
    if (!kind || !verdict.ok) {
      await this.telegram.answerCallback(query.id, verdict.message || "Esse pedido expirou");
      return;
    }
    const originThread = query.message?.message_thread_id || 0;
    if (token.threadId && originThread && originThread !== token.threadId) {
      await this.telegram.answerCallback(query.id, "Sem permissão");
      return;
    }
    token.status = "em_execucao";
    token.ownerPid = process.pid;
    try {
      await this.persist();
    } catch (error) {
      token.status = "pending";
      token.ownerPid = 0;
      this.state.lastError = `persistência: ${error.message}`;
      await this.telegram.answerCallback(query.id, "Não registrei a aprovação. Toque de novo.");
      return;
    }
    const tab = this.tabs().find((item) => item.key === token.key);
    if (!tab?.window) {
      token.status = "invalid";
      await this.persist().catch(() => {});
      await this.telegram.answerCallback(query.id, "Aba fechada");
      return;
    }
    try {
      await this.cursor.prepareConversation(tab.window.targetId, tab.tab?.title || "");
      const surface = await this.cursor.readSurface(tab.window.targetId);
      if (!this.titleMatches(surface, tab.tab?.title || "")) {
        token.status = "invalid";
        await this.persist().catch(() => {});
        await this.telegram.answerCallback(query.id, "Não confirmei a conversa");
        return;
      }
      if (!approvalStillMatches(token, surface.approvals)) {
        token.status = "invalid";
        await this.persist().catch(() => {});
        await this.telegram.answerCallback(query.id, "O pedido mudou");
        return;
      }
      const match = (surface.approvals || []).find((item) => approvalHash(item) === token.hash);
      await this.cursor.clickKind(tab.window.targetId, kind, match?.index || 0);
      token.status = "consumed";
      await this.persist().catch(() => {});
      await this.telegram.answerCallback(query.id, kind === "approve" ? "Aprovado" : "Recusado");
    } catch (error) {
      if (error.beforeEffect) {
        token.status = "pending";
        token.ownerPid = 0;
        await this.persist().catch(() => {});
        await this.telegram.answerCallback(query.id, error.message.slice(0, 180));
        return;
      }
      token.status = "uncertain";
      token.error = error.message;
      await this.persist().catch(() => {});
      await this.telegram.answerCallback(query.id, "Resultado incerto. Não repeti o clique.");
    }
  }

  async handleForgetCallback(query, data) {
    const cancel = data.startsWith("e:x:");
    const tokenId = cancel ? data.slice(4) : data.slice(2);
    const token = this.state.forgetTokens?.[tokenId];
    if (!token || token.expiresAt < Date.now()) {
      await this.telegram.answerCallback(query.id, "Esse pedido expirou");
      return;
    }
    const originThread = query.message?.message_thread_id || 0;
    if (token.threadId && originThread && originThread !== token.threadId) {
      await this.telegram.answerCallback(query.id, "Sem permissão");
      return;
    }
    delete this.state.forgetTokens[tokenId];
    if (cancel) {
      await this.telegram.answerCallback(query.id, "Cancelado");
      return;
    }
    const removed = await this.forgetTopic(this.chatId(), token.key);
    await this.persist().catch(() => {});
    await this.telegram.answerCallback(query.id, removed ? "Histórico apagado" : "Não consegui apagar");
  }

  async pair(code, userId, chatId, threadId) {
    const expectedUser = this.config.allowedUserId || this.state.allowedUserId;
    const expectedChat = this.config.chatId || this.state.chatId;
    if (expectedUser && expectedChat) {
      if (String(userId) !== String(expectedUser) || String(chatId) !== String(expectedChat)) return;
      await this.reply(threadId, "A conta e o grupo já estão definidos.");
      return;
    }
    if (!this.state.pairingCode) {
      await this.reply(threadId, "Pareamento indisponível. Reinicie a ponte e leia o código no terminal.");
      return;
    }
    const validCode = String(code || "").trim().toLowerCase() === String(this.state.pairingCode).toLowerCase();
    const userOk = !expectedUser || String(userId) === String(expectedUser);
    const chatOk = !expectedChat || String(chatId) === String(expectedChat);
    if (!validCode || !userOk || !chatOk) {
      await this.reply(threadId, "Código inválido.");
      return;
    }
    if (!expectedUser) this.state.allowedUserId = String(userId);
    if (!expectedChat) this.state.chatId = String(chatId);
    this.state.pairingCode = "";
    try {
      const chat = await this.telegram.getChat(chatId);
      this.state.forum = Boolean(chat.is_forum);
    } catch (error) {
      this.logEvent("telegram", { event: "pair_chat", error: error.message });
    }
    await this.persist();
    await this.reply(threadId, "Pareamento concluído. Envie /status para conferir.");
  }

  async cursorLoop() {
    while (this.running) {
      try {
        await this.syncOnce();
      } catch (error) {
        this.state.lastError = error.message;
        this.logEvent("cursor", { event: "sync_failed", error: error.message });
      }
      await sleep(this.config.pollIntervalMs);
    }
  }

  async telegramLoop() {
    let delay = 1000;
    while (this.running) {
      try {
        const updates = await this.telegram.getUpdates(this.state.updateOffset || undefined, 25);
        if (this.state.telegramDownNotified) {
          this.state.telegramDownNotified = false;
          this.logEvent("telegram", { event: "up" });
          if (this.chatId()) {
            try {
              await this.telegram.sendText(this.chatId(), "A conexão com o Telegram voltou.");
            } catch (error) {
              this.logEvent("telegram", { event: "recovery_notice_failed", error: error.message });
            }
          }
        }
        delay = 1000;
        for (const update of updates) {
          if (!this.running) return;
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.running) return;
        const kind = classifyTelegramError(error);
        this.state.lastError = `Telegram (${kind}): ${error.message}`;
        this.logEvent("telegram", { event: "down", kind, error: error.message });
        if (kind === "invalid_token") {
          if (!this.state.tokenInvalidNotified) {
            this.state.tokenInvalidNotified = true;
            this.log("Token do Telegram rejeitado. Confira TELEGRAM_BOT_TOKEN.");
          }
          await sleep(60000);
          continue;
        }
        this.state.telegramDownNotified = true;
        const jitter = Math.floor(Math.random() * 250);
        await sleep(delay + jitter);
        delay = Math.min(delay * 2, 30000);
      }
    }
  }

  async shutdown({ exit = true } = {}) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.intakeOpen = false;
    this.running = false;
    this.telegram.stop?.();
    await Promise.race([
      Promise.allSettled([this.syncChain, this.saveChain]),
      sleep(8000),
    ]);
    const notes = reconcileOperations(this.state.operations, Date.now(), -1);
    reconcileTokens(this.state.approvalTokens, Date.now(), -1);
    if (notes.length) {
      this.state.pendingAtShutdown = notes.map((op) => ({
        id: op.id,
        status: op.status,
        destination: op.destination || String(op.threadId || ""),
        error: op.error || "",
      }));
    }
    try {
      await this.persist();
    } catch (error) {
      this.logEvent("state", { event: "shutdown_save_failed", error: error.message });
    }
    try {
      await this.releaseLock?.();
    } catch (error) {
      this.logEvent("state", { event: "unlock_failed", error: error.message });
    }
    this.cursor.close?.();
    if (exit) process.exit(0);
  }
}

function savedSignature(state) {
  const { lastCursorReadAt, ...rest } = state;
  return JSON.stringify(rest);
}

function sameProjectLoose(topic, tab) {
  if (topic.projectName && tab.projectName) return topic.projectName === tab.projectName;
  if (tab.projectName && String(topic.title || "").startsWith(`${tab.projectName} ·`)) return true;
  return false;
}

async function main() {
  let config = await loadConfig();
  let errors = validateConfig(config);
  while (errors.length) {
    for (const error of errors) console.error(error);
    await sleep(15000);
    config = await loadConfig();
    errors = validateConfig(config);
  }
  const selectors = JSON.parse(await readFile(path.join(rootDir, "selectors.json"), "utf8"));
  let state;
  try {
    state = await loadState();
  } catch (error) {
    console.error(`Não abri o estado: ${error.message}`);
    if (error.quarantineFile) console.error(`Arquivo preservado em ${error.quarantineFile}`);
    process.exit(1);
  }
  if (state.recoveredFrom) {
    console.error(`Estado inválido preservado em ${state.quarantineFile}. Continuei a partir da cópia de recuperação.`);
    state.recoveredFrom = "";
    state.quarantineFile = "";
  }
  if (config.chatId) state.chatId = config.chatId;
  if (config.allowedUserId) state.allowedUserId = config.allowedUserId;
  const lockFile = path.join(rootDir, "data", "bridge.lock");
  let lock;
  try {
    lock = await acquireLock(lockFile);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (lock.recovered) console.error(`Recuperei um bloqueio abandonado do pid ${lock.abandonedPid}.`);
  if (!state.allowedUserId || !state.chatId) {
    if (!state.pairingCode) state.pairingCode = randomBytes(3).toString("hex");
    console.error(`Pareamento pendente. No grupo, envie /parear ${state.pairingCode}`);
  }
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
    releaseLock: () => releaseLock(lockFile),
  });
  const stop = () => {
    bridge.shutdown({ exit: true });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await telegram.publishCommands([
      { command: "menu", description: "Mostra os botões" },
      { command: "projetos", description: "Lista os projetos e as conversas" },
      { command: "ativas", description: "A conversa visível de cada Cursor" },
      { command: "abas", description: "Lista as conversas" },
      { command: "recarregar", description: "Limpa ou atualiza os tópicos" },
      { command: "status", description: "Estado da ponte" },
      { command: "diagnostico", description: "O que falhou e o próximo passo" },
      { command: "tela", description: "Captura a janela" },
      { command: "parar", description: "Interrompe o agente" },
      { command: "ajuda", description: "Como usar" },
    ], state.chatId || "");
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
