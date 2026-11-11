import { setTimeout as sleep } from "node:timers/promises";
import { chunkText } from "./delivery.mjs";

export class Telegram {
  constructor(token, apiBase = "https://api.telegram.org") {
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.chain = Promise.resolve();
    this.lastSent = 0;
  }

  enqueue(fn) {
    const run = this.chain.then(async () => {
      const wait = 350 - (Date.now() - this.lastSent);
      if (wait > 0) await sleep(wait);
      this.lastSent = Date.now();
      return fn();
    });
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  async call(method, body, { queued = true } = {}) {
    const exec = async (attempt = 0) => {
      const response = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
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
        throw error;
      }
      return payload.result;
    };
    return queued ? this.enqueue(exec) : exec();
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

  setMyCommands(commands) {
    return this.call("setMyCommands", { commands });
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
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
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
