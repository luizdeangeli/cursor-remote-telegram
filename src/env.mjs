import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function interpretPoll(raw) {
  const text = raw == null || raw === "" ? "2000" : String(raw).trim();
  if (!/^\d+$/.test(text)) {
    return { error: `POLL_INTERVAL_MS inválido (${raw}). Use um inteiro entre 500 e 120000.` };
  }
  const value = Number(text);
  if (value < 500 || value > 120000) {
    return { error: `POLL_INTERVAL_MS inválido (${value}). Use um inteiro entre 500 e 120000.` };
  }
  return { value };
}

export function validateConfig(config) {
  const errors = [];
  if (!config.token) errors.push("Falta TELEGRAM_BOT_TOKEN em .env.");
  if (config.allowedUserId && !/^\d+$/.test(config.allowedUserId)) {
    errors.push("TELEGRAM_ALLOWED_USER_ID precisa ser o id numérico da sua conta.");
  }
  if (config.chatId && !/^-?\d+$/.test(config.chatId)) {
    errors.push("TELEGRAM_CHAT_ID precisa ser numérico, incluindo o sinal de menos do grupo.");
  }
  if (config.pollError) errors.push(config.pollError);
  if (!config.cdpUrl) errors.push("CDP_URL está vazio.");
  return errors;
}

export async function loadConfig(envPath = path.join(rootDir, ".env")) {
  let file = {};
  try {
    file = parseEnv(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const pick = (key, fallback = "") => process.env[key] ?? file[key] ?? fallback;
  const poll = interpretPoll(pick("POLL_INTERVAL_MS", "2000"));
  return {
    token: pick("TELEGRAM_BOT_TOKEN").trim(),
    allowedUserId: pick("TELEGRAM_ALLOWED_USER_ID").trim(),
    chatId: pick("TELEGRAM_CHAT_ID").trim(),
    cdpUrl: pick("CDP_URL", "http://127.0.0.1:9222").replace(/\/$/, ""),
    pollIntervalMs: poll.value || 0,
    pollError: poll.error || "",
    apiBase: pick("TELEGRAM_API_BASE", "https://api.telegram.org").replace(/\/$/, ""),
    shareMode: pick("COMPARTILHAR", "todas").trim().toLowerCase() === "escolhidas" ? "escolhidas" : "todas",
  };
}
