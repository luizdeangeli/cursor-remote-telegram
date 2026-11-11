import { createHash } from "node:crypto";

export function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function unclosedFence(text) {
  let open = "";
  for (const line of String(text).split("\n")) {
    const match = line.match(/^(\s*)(`{3,})(.*)$/);
    if (!match) continue;
    const marker = match[2];
    const rest = match[3].trim();
    if (open && marker.length >= open.marker.length && !rest) open = "";
    else if (!open) open = { marker, info: rest.split(/\s+/)[0] || "" };
  }
  return open;
}

export function chunkText(text, size = 4000) {
  const source = Array.from(String(text ?? "").trim());
  if (!source.length) return [];
  const chunks = [];
  let rest = source;
  let openFence = null;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const asText = window.join("");
    let cut = asText.lastIndexOf("\n");
    if (cut < Math.floor(size * 0.5)) cut = size;
    else cut = Array.from(asText.slice(0, cut)).length;
    let piece = rest.slice(0, cut).join("");
    rest = rest.slice(cut);
    if (rest[0] === "\n") rest = rest.slice(1);
    if (openFence) piece = `${openFence.marker}${openFence.info}\n${piece}`;
    const fence = unclosedFence(piece);
    if (fence) {
      chunks.push(`${piece}\n${fence.marker}`);
      openFence = fence;
    } else {
      chunks.push(piece);
      openFence = null;
    }
  }
  if (rest.length) {
    const tail = rest.join("");
    chunks.push(openFence ? `${openFence.marker}${openFence.info}\n${tail}` : tail);
  }
  return chunks;
}

export function projectName(windowTitle) {
  const raw = String(windowTitle || "Cursor")
    .replace(/\s[-–—]\sCursor\s*$/i, "")
    .trim();
  return raw.split(/\s[-–—]\s/).pop() || raw || "Cursor";
}

export function tabKey(windowTitle, tab) {
  const id = tab?.id || tab?.title || "ativa";
  return `${projectName(windowTitle)}::${id}`;
}

export function topicTitle(windowTitle, tab) {
  const project = projectName(windowTitle);
  const name = (tab?.title || "Agente").replace(/\s+/g, " ").trim() || "Agente";
  const prefix = `${project} · `;
  return `${prefix}${name}`.slice(0, 128);
}

export function conversationName(project, title) {
  const prefix = `${project} · `;
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  const name = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
  return name || "conversa";
}

export function topicUrl(chatId, threadId) {
  const raw = String(chatId || "");
  const id = raw.startsWith("-100") ? raw.slice(4) : raw.replace(/^-/, "");
  if (!/^\d+$/.test(id) || !Number(threadId)) return "";
  return `https://t.me/c/${id}/${threadId}`;
}

export function messageHash(message) {
  return fingerprint(`${message.role}\n${message.id}\n${message.text}`);
}

function normalize(text) {
  return normalizeText(text);
}

function isNoise(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return true;
  return lines.every((line) => (
    /^(thought|thinking|pensando|trabalhando…|trabalhando\.\.\.)(\s+\d+\s*s|\s+briefly)?$/i.test(line)
    || /^\d+\s*s$/i.test(line)
    || /^briefly$/i.test(line)
  ));
}

export function planOutbound({ messages = [], status = "idle", activity = "", sent = [], ownPrompts = [] }) {
  const sentSet = new Set(sent);
  const own = new Set(ownPrompts.map(normalize));
  const assistants = messages.filter((message) => message.role === "assistant" && message.text && !isNoise(message.text));
  const stable = status === "idle" ? assistants : assistants.slice(0, -1);
  const finals = [];
  for (const message of stable) {
    const hash = messageHash(message);
    if (sentSet.has(hash)) continue;
    finals.push({ hash, role: "assistant", text: message.text, truncated: Boolean(message.truncated) });
  }
  const echoes = [];
  for (const message of messages.filter((item) => item.role === "human" && item.text)) {
    if (own.has(normalize(message.text))) continue;
    const hash = messageHash(message);
    if (sentSet.has(hash)) continue;
    echoes.push({ hash, role: "human", text: message.text });
  }
  const progress = status === "idle" ? "" : (activity || "Trabalhando…");
  return { finals, echoes, progress };
}

export function shortId(value) {
  return fingerprint(value).slice(0, 10);
}
