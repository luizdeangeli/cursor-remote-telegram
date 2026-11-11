import { setTimeout as sleep } from "node:timers/promises";
import { chunkText } from "./delivery.mjs";

export function classifyTelegramError(error) {
  const code = Number(error?.code || 0);
  const message = String(error?.message || "");
  if (error?.name === "TimeoutError" || error?.name === "AbortError" || /tempo esgotado|timeout/i.test(message)) {
    return "temporary";
  }
  if (code === 401 || /unauthorized/i.test(message)) return "invalid_token";
  if (code === 403 || /not enough rights|administrator|forbidden/i.test(message)) return "permission";
  if (code === 400 && /chat not found|bot was kicked|topic not found|thread not found|message thread not found/i.test(message)) {
    return "missing_destination";
  }
  if (code === 429) return "rate_limit";
  if (!code || code >= 500) return "temporary";
  return "permanent";
}

export function backoffMs(attempt, base = 500, cap = 30000) {
  const exp = Math.min(cap, base * 2 ** attempt);
  return exp + Math.floor(Math.random() * 250);
}

export class Telegram {
  constructor(token, apiBase = "https://api.telegram.org", { minIntervalMs = 350 } = {}) {
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.minIntervalMs = minIntervalMs;
    this.high = [];
    this.low = [];
    this.pumping = false;
    this.lastSent = 0;
    this.abort = new AbortController();
  }

  enqueue(fn, { priority = false } = {}) {
    return new Promise((resolve, reject) => {
      (priority ? this.high : this.low).push({ fn, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    if (this.pumping) return;
    this.pumping = true;
    this.#drain();
  }

  async #drain() {
    try {
      while (this.high.length || this.low.length) {
        const item = this.high.shift() || this.low.shift();
        const wait = this.minIntervalMs - (Date.now() - this.lastSent);
        if (wait > 0) await sleep(wait);
        this.lastSent = Date.now();
        try {
          item.resolve(await item.fn());
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.pumping = false;
      if (this.high.length || this.low.length) this.#pump();
    }
  }

  stop() {
    this.abort.abort();
  }

  async call(method, body, { queued = true, timeoutMs, priority = false } = {}) {
    const exec = async (attempt = 0) => {
      const timeout = timeoutMs ?? (method === "getUpdates" ? ((Number(body?.timeout) || 0) + 15) * 1000 : 15000);
      let response;
      try {
        response = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.any([AbortSignal.timeout(timeout), this.abort.signal]),
        });
      } catch (error) {
        error.code = error.code || 0;
        if (method !== "getUpdates" && classifyTelegramError(error) === "temporary" && attempt < 3) {
          await sleep(backoffMs(attempt));
          return exec(attempt + 1);
        }
        throw error;
      }
      const payload = await response.json().catch(() => ({}));
      if (!payload.ok) {
        const description = payload.description || `HTTP ${response.status}`;
        const error = new Error(description);
        error.code = payload.error_code || response.status;
        error.retryAfter = Number(payload.parameters?.retry_after || 0);
        if (error.code === 429 && attempt < 3 && error.retryAfter > 0 && error.retryAfter <= 60) {
          await sleep(error.retryAfter * 1000);
          return exec(attempt + 1);
        }
        if (method !== "getUpdates" && classifyTelegramError(error) === "temporary" && attempt < 3) {
          await sleep(backoffMs(attempt));
          return exec(attempt + 1);
        }
        throw error;
      }
      return payload.result;
    };
    return queued ? this.enqueue(exec, { priority }) : exec();
  }

  getUpdates(offset, timeout = 25) {
    return this.call("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "callback_query"],
    }, { queued: false });
  }

  getChat(chatId) {
    return this.call("getChat", { chat_id: chatId });
  }

  getMe() {
    return this.call("getMe", {}, { priority: true });
  }

  getChatMember(chatId, userId) {
    return this.call("getChatMember", { chat_id: chatId, user_id: userId }, { priority: true });
  }

  sendExact(chatId, text, extra = {}) {
    const { priority, ...rest } = extra;
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...rest,
    }, { priority: Boolean(priority) });
  }

  async sendText(chatId, text, extra = {}) {
    const parts = chunkText(text);
    let last = null;
    for (const part of parts) {
      last = await this.call("sendMessage", {
        chat_id: chatId,
        text: part,
        ...extra,
        reply_markup: part === parts.at(-1) ? extra.reply_markup : undefined,
      });
    }
    return last;
  }

  deleteMessage(chatId, messageId) {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  editMarkup(chatId, messageId, replyMarkup) {
    return this.call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  editMessage(chatId, messageId, text, replyMarkup) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: chunkText(text, 4000)[0] || "…",
      reply_markup: replyMarkup,
    });
  }

  editText(chatId, messageId, text) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: chunkText(text, 4000)[0] || "…",
    });
  }

  createForumTopic(chatId, name) {
    return this.call("createForumTopic", { chat_id: chatId, name: name.slice(0, 128) });
  }

  deleteForumTopic(chatId, threadId) {
    return this.call("deleteForumTopic", {
      chat_id: chatId,
      message_thread_id: threadId,
    });
  }

  editForumTopic(chatId, threadId, name) {
    return this.call("editForumTopic", {
      chat_id: chatId,
      message_thread_id: threadId,
      name: name.slice(0, 128),
    });
  }

  setMyCommands(commands, scope) {
    const body = { commands };
    if (scope) body.scope = scope;
    return this.call("setMyCommands", body);
  }

  setChatMenuButton(chatId = "") {
    const body = { menu_button: { type: "commands" } };
    if (chatId) body.chat_id = chatId;
    return this.call("setChatMenuButton", body);
  }

  async publishCommands(commands, chatId = "") {
    const scopes = [
      null,
      { type: "all_private_chats" },
      { type: "all_group_chats" },
      { type: "all_chat_administrators" },
    ];
    if (chatId) {
      scopes.push({ type: "chat", chat_id: chatId });
      scopes.push({ type: "chat_administrators", chat_id: chatId });
    }
    const errors = [];
    for (const scope of scopes) {
      try {
        await this.setMyCommands(commands, scope);
      } catch (error) {
        errors.push(`${scope?.type || "default"}: ${error.message}`);
      }
    }
    try {
      await this.setChatMenuButton();
    } catch (error) {
      errors.push(`botão: ${error.message}`);
    }
    if (chatId) {
      try {
        await this.setChatMenuButton(chatId);
      } catch {
        // No grupo o botão nasce da lista de comandos, não deste método.
      }
    }
    if (errors.length) throw new Error(errors.join("; "));
  }

  pinChatMessage(chatId, messageId) {
    return this.call("pinChatMessage", {
      chat_id: chatId,
      message_id: messageId,
      disable_notification: true,
    });
  }

  setForumTopicIcon(chatId, threadId, emojiId) {
    return this.call("editForumTopic", {
      chat_id: chatId,
      message_thread_id: threadId,
      icon_custom_emoji_id: String(emojiId),
    });
  }

  answerCallback(id, text = "") {
    return this.call("answerCallbackQuery", { callback_query_id: id, text }, { priority: true });
  }

  async sendPhoto(chatId, png, extra = {}) {
    return this.enqueue(async () => {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      if (extra.message_thread_id) form.set("message_thread_id", String(extra.message_thread_id));
      if (extra.caption) form.set("caption", extra.caption.slice(0, 1000));
      form.set("photo", new Blob([png], { type: "image/png" }), "tela.png");
      const response = await fetch(`${this.apiBase}/bot${this.token}/sendPhoto`, {
        method: "POST",
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!payload.ok) throw new Error(payload.description || "falha ao enviar a tela");
      this.lastSent = Date.now();
      return payload.result;
    });
  }
}
