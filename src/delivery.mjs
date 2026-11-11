import { createHash } from "node:crypto";

export function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function chunkText(text, size = 4000) {
  const source = String(text ?? "").trim();
  if (!source) return [];
  const chunks = [];
  let rest = source;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < Math.floor(size * 0.5)) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function tabKey(windowTitle, tab) {
  const raw = String(windowTitle || "Cursor")
    .replace(/\s[-–—]\sCursor\s*$/i, "")
    .trim();
  const folder = raw.split(/\s[-–—]\s/).pop() || raw || "Cursor";
  const id = tab?.id || tab?.title || "ativa";
  return `${folder}::${id}`;
}

export function topicTitle(_windowTitle, tab) {
  const name = (tab?.title || "Agente").replace(/\s+/g, " ").trim();
  return name.slice(0, 120) || "Agente";
}

export function messageHash(message) {
  return fingerprint(`${message.role}\n${message.id}\n${message.text}`);
}

function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
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
    finals.push({ hash, role: "assistant", text: message.text });
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
