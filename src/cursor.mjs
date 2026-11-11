import { setTimeout as sleep } from "node:timers/promises";
import { CdpSession, listTargets } from "./cdp.mjs";
import { normalizeText } from "./delivery.mjs";

const sleepMs = (ms) => sleep(ms);

function readExpression(selectors) {
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\\u00a0/g, " ").trim();
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8;
    };
    const count = (sel) => {
      try { return document.querySelectorAll(sel).length; } catch { return -1; }
    };
    const first = (list) => {
      for (const sel of list) {
        try {
          const found = [...document.querySelectorAll(sel)].filter(visible);
          if (found.length) return found;
        } catch {}
      }
      return [];
    };
    const roleOf = (el) => {
      const kind = el.getAttribute("data-message-kind") || "";
      const role = el.getAttribute("data-message-role") || "";
      if (/tool/i.test(kind)) return "tool";
      if (/think/i.test(kind)) return "thinking";
      if (/human|user/i.test(kind) || /human|user/i.test(role)) return "human";
      if (/assistant/i.test(kind)) return "assistant";
      if (!kind && /assistant|ai|bot/i.test(role)) return "assistant";
      const blob = typeof el.className === "string" ? el.className : "";
      if (/human|user/i.test(blob)) return "human";
      if (/assistant/i.test(blob)) return "assistant";
      return "unknown";
    };
    const nodes = [];
    try {
      for (const el of document.querySelectorAll(selectors.messages)) nodes.push(el);
    } catch {}
    const messages = [];
    const seen = new Set();
    for (const el of nodes) {
      if (nodes.some((other) => other !== el && other.contains(el))) continue;
      const full = textOf(el);
      if (!full) continue;
      const limit = 100000;
      const truncated = full.length > limit;
      let text = truncated ? full.slice(0, limit) : full;
      if (truncated && /[\\uD800-\\uDBFF]$/.test(text)) text = text.slice(0, -1);
      const id = el.getAttribute("data-message-id")
        || el.getAttribute("data-flat-index")
        || el.getAttribute("data-message-index")
        || "";
      const key = id + ":" + text.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push({ id: id || key, role: roleOf(el), text, truncated });
    }
    const tabs = [];
    const skipTitles = new Set(["New Agent", "Search", "Automations", "Customize", "More", "Mais"]);
    const tabNodes = [...document.querySelectorAll(".agent-sidebar-list .agent-sidebar-cell")];
    let tabsIncomplete = false;
    tabNodes.forEach((el, index) => {
      const label = el.querySelector(".agent-sidebar-cell-text");
      const title = textOf(label).split("\\n")[0].slice(0, 80);
      if (!title || title.startsWith("Draft:")) return;
      if (label && /\\btertiary\\b/.test(label.className || "")) return;
      if (skipTitles.has(title)) {
        if (title === "More" || title === "Mais") tabsIncomplete = true;
        return;
      }
      const stableId = el.getAttribute("data-composer-id")
        || el.getAttribute("data-agent-id")
        || el.getAttribute("data-conversation-id")
        || "";
      tabs.push({
        id: stableId || title,
        stableId,
        title,
        active: el.getAttribute("data-selected") === "true",
        index,
        ambiguous: false,
      });
    });
    const titleCounts = new Map();
    for (const tab of tabs) titleCounts.set(tab.title, (titleCounts.get(tab.title) || 0) + 1);
    tabs.forEach((tab, occurrence) => {
      if (!tab.stableId && (titleCounts.get(tab.title) || 0) > 1) {
        tab.ambiguous = true;
        tab.id = tab.title + "#" + occurrence;
      }
    });
    const composer = document.querySelector("[data-composer-id]");
    if (!tabs.length) {
      tabs.push({
        id: composer?.getAttribute("data-composer-id") || "ativa",
        title: (document.title || "Agente").replace(/\\s[-–—]\\sCursor\\s*$/i, "").slice(0, 80),
        active: true,
        index: 0,
        synthetic: true,
      });
    } else if (!tabs.some((tab) => tab.active)) {
      tabs[0].active = true;
    }
    const approve = first(selectors.approve);
    const reject = first(selectors.reject);
    const stop = first(selectors.stop);
    const commandNode = first(selectors.command)[0];
    const approvals = approve.map((button, index) => ({
      index,
      label: textOf(button).slice(0, 80) || "Aprovar",
      command: textOf(commandNode || button.closest("[class*='tool']") || button.parentElement).slice(0, 500),
    }));
    let status = "idle";
    let activity = "";
    const composerStatus = document.querySelector("[data-composer-status]")?.getAttribute("data-composer-status") || "";
    if (approvals.length) {
      status = "waiting_approval";
      activity = approvals[0].command ? "Aguardando aprovação: " + approvals[0].command : "Aguardando aprovação";
    } else if (stop.length || (composerStatus && !/none|idle|complete/i.test(composerStatus))) {
      status = "running";
      activity = "Trabalhando…";
    }
    let composerText = "";
    for (const sel of selectors.chatInput) {
      try {
        const input = [...document.querySelectorAll(sel)].filter(visible)[0];
        if (!input) continue;
        composerText = (input.isContentEditable ? (input.innerText || "") : (input.value || "")).replace(/\\u00a0/g, " ");
        break;
      } catch {}
    }
    const barTitle = [...document.querySelectorAll(".composite-bar-action-tab.checked a.action-label")]
      .map((el) => el.getAttribute("title") || el.textContent || "")
      .join("");
    const activeTitle = (
      document.querySelector(".auxiliary-bar-chat-title")?.getAttribute("title")
      || barTitle
      || tabs.find((tab) => tab.active)?.title
      || ""
    ).replace(/\\s+/g, " ").trim();
    const workspacePath = document.querySelector("[data-workspace-path]")?.getAttribute("data-workspace-path")
      || document.querySelector("[data-folder-uri]")?.getAttribute("data-folder-uri")
      || "";
    return {
      title: document.title || "Cursor",
      activeTitle,
      workspacePath,
      tabs,
      tabsIncomplete,
      listReliable: tabNodes.length > 0 && !tabsIncomplete,
      messages: messages.slice(-40),
      historyTruncated: messages.length > 40,
      status,
      activity,
      approvals,
      composerText,
      composerFound: first(selectors.chatInput).length > 0,
      probe: {
        sidebarCells: count(".agent-sidebar-list .agent-sidebar-cell"),
        messageNodes: count(selectors.messages),
        composer: first(selectors.chatInput).length,
        barTabs: count(".composite-bar-action-tab"),
      },
    };
  })()`;
}

function focusExpression(selectors) {
  return `(() => {
    const selectors = ${JSON.stringify(selectors.chatInput)};
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 20 && rect.height > 10;
    };
    let input = null;
    for (const sel of selectors) {
      try {
        const found = [...document.querySelectorAll(sel)].filter(visible);
        input = found.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
        if (input) break;
      } catch {}
    }
    if (!input) return { ok: false, error: "Campo do agente não encontrado" };
    input.scrollIntoView({ block: "center" });
    input.focus();
    input.click();
    return { ok: true };
  })()`;
}

function clickExpression(list, index) {
  return `(() => {
    const list = ${JSON.stringify(list)};
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 4 && rect.height > 4;
    };
    const found = [];
    for (const sel of list) {
      try { found.push(...[...document.querySelectorAll(sel)].filter(visible)); } catch {}
      if (found.length) break;
    }
    const button = found[${index}] || found[0];
    if (!button) return { ok: false, error: "Botão não encontrado" };
    button.scrollIntoView({ block: "center" });
    button.click();
    return { ok: true, label: (button.innerText || "").trim().slice(0, 80) };
  })()`;
}

function clickTabExpression(title) {
  return `(() => {
    const wanted = ${JSON.stringify(title || "")}.replace(/\\s+/g, " ").trim();
    if (!wanted) return { ok: false, error: "Aba não encontrada" };
    const openTitle = (document.querySelector(".auxiliary-bar-chat-title")?.getAttribute("title") || "").replace(/\\s+/g, " ").trim();
    if (openTitle === wanted) return { ok: true };
    const nameOf = (el) => (el?.getAttribute("title") || el?.textContent || "").replace(/\\s+/g, " ").trim();
    const bar = [...document.querySelectorAll(".composite-bar-action-tab")].find((el) => {
      return nameOf(el.querySelector("a.action-label")) === wanted;
    });
    if (bar) {
      if (bar.classList.contains("checked")) return { ok: true };
      (bar.querySelector("a.action-label") || bar).click();
      return { ok: true };
    }
    const cell = [...document.querySelectorAll(".agent-sidebar-list .agent-sidebar-cell")].find((el) => {
      return nameOf(el.querySelector(".agent-sidebar-cell-text")).split("\\n")[0].trim() === wanted;
    });
    if (!cell) return { ok: false, error: "Aba não encontrada" };
    if (cell.getAttribute("data-selected") === "true") return { ok: true };
    cell.click();
    return { ok: true };
  })()`;
}

export class CursorClient {
  constructor(cdpUrl, selectors) {
    this.cdpUrl = cdpUrl;
    this.selectors = selectors;
    this.sessions = new Map();
  }

  async windows(onGap = async () => {}) {
    const targets = await listTargets(this.cdpUrl);
    const windows = [];
    await onGap();
    for (const target of targets) {
      await onGap();
      try {
        const session = await this.#session(target);
        const snapshot = await session.evaluate(readExpression(this.selectors));
        windows.push({
          targetId: target.id,
          url: target.url,
          title: snapshot?.title || target.title || "Cursor",
          ...snapshot,
        });
      } catch (error) {
        this.sessions.get(target.id)?.close();
        this.sessions.delete(target.id);
        windows.push({
          targetId: target.id,
          title: target.title || "Cursor",
          tabs: [],
          messages: [],
          status: "error",
          activity: error.message,
          approvals: [],
          error: error.message,
        });
      }
    }
    for (const id of [...this.sessions.keys()]) {
      if (!targets.some((target) => target.id === id)) {
        this.sessions.get(id)?.close();
        this.sessions.delete(id);
      }
    }
    return windows;
  }

  async #session(target) {
    const current = this.sessions.get(target.id);
    if (current?.ws?.readyState === WebSocket.OPEN) return current;
    current?.close();
    const session = new CdpSession(target.webSocketDebuggerUrl);
    await session.open();
    this.sessions.set(target.id, session);
    return session;
  }

  async #withTarget(targetId) {
    const targets = await listTargets(this.cdpUrl);
    const target = targets.find((item) => item.id === targetId);
    if (!target) throw new Error("Janela do Cursor não está mais aberta");
    return this.#session(target);
  }

  async #surface(session) {
    const snapshot = await session.evaluate(readExpression(this.selectors));
    const active = (snapshot?.tabs || []).find((tab) => tab.active);
    return {
      title: snapshot?.activeTitle || active?.title || "",
      activeTab: active?.title || "",
      composer: snapshot?.composerText || "",
      approvals: snapshot?.approvals || [],
      messages: snapshot?.messages || [],
      status: snapshot?.status || "",
      tabsIncomplete: Boolean(snapshot?.tabsIncomplete),
      historyTruncated: Boolean(snapshot?.historyTruncated),
    };
  }

  async readSurface(targetId) {
    const session = await this.#withTarget(targetId);
    return this.#surface(session);
  }

  async prepareConversation(targetId, title, { timeoutMs = 4000 } = {}) {
    const wanted = String(title || "").replace(/\s+/g, " ").trim();
    if (!wanted) throw Object.assign(new Error("Conversa sem título"), { beforeEffect: true });
    const session = await this.#withTarget(targetId);
    const started = Date.now();
    let clicked = false;
    let last = "";
    while (Date.now() - started <= timeoutMs) {
      const surface = await this.#surface(session);
      last = surface.title || surface.activeTab || "";
      if (normalizeText(surface.title) === normalizeText(wanted) || normalizeText(surface.activeTab) === normalizeText(wanted)) {
        return { title: last || wanted };
      }
      if (!clicked) {
        const result = await session.evaluate(clickTabExpression(wanted));
        if (!result?.ok) {
          throw Object.assign(new Error(result?.error || "Não consegui abrir a aba"), { beforeEffect: true });
        }
        clicked = true;
      }
      if (Date.now() - started >= timeoutMs) break;
      await sleepMs(150);
    }
    throw Object.assign(
      new Error(`Não confirmei a conversa "${wanted}". A janela está em "${last || "desconhecida"}".`),
      { beforeEffect: true },
    );
  }

  async submitPrompt(targetId, text) {
    const session = await this.#withTarget(targetId);
    const before = await this.#surface(session);
    if (String(before.composer || "").trim()) {
      throw Object.assign(
        new Error("Há um rascunho nesta conversa. Não enviei o prompt e não apaguei o texto."),
        { beforeEffect: true, draft: true },
      );
    }
    const focused = await session.evaluate(focusExpression(this.selectors));
    if (!focused?.ok) {
      throw Object.assign(new Error(focused?.error || "Campo do agente não encontrado"), { beforeEffect: true });
    }
    await sleepMs(80);
    await session.insertText(text);
    await sleepMs(120);
    const after = await this.#surface(session);
    if (normalizeText(after.composer) !== normalizeText(text)) {
      throw Object.assign(
        new Error("O campo não ficou só com o prompt. Não pressionei Enter."),
        { beforeEffect: true },
      );
    }
    await session.pressKey("Enter", "Enter", 13);
  }

  async observePrompt(targetId, text, { timeoutMs = 3000 } = {}) {
    const session = await this.#withTarget(targetId);
    const started = Date.now();
    let last = null;
    while (Date.now() - started <= timeoutMs) {
      last = await this.#surface(session);
      const found = (last.messages || []).some((message) => (
        message.role === "human" && !message.truncated && normalizeText(message.text) === normalizeText(text)
      ));
      if (found) return { ok: true, title: last.title || last.activeTab || "" };
      if (Date.now() - started >= timeoutMs) break;
      await sleepMs(200);
    }
    return { ok: false, title: last?.title || last?.activeTab || "" };
  }

  async clickKind(targetId, kind, index = 0) {
    const session = await this.#withTarget(targetId);
    const list = this.selectors[kind];
    const result = await session.evaluate(clickExpression(list, index));
    if (!result?.ok) {
      throw Object.assign(new Error(result?.error || "Botão não encontrado"), { beforeEffect: true });
    }
    return result;
  }

  async screenshot(targetId) {
    const session = await this.#withTarget(targetId);
    return session.screenshot();
  }

  close() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
