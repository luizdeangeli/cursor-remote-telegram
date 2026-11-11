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

export async function loadConfig(envPath = path.join(rootDir, ".env")) {
  let file = {};
  try {
    file = parseEnv(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const pick = (key, fallback = "") => process.env[key] ?? file[key] ?? fallback;
  return {
    token: pick("TELEGRAM_BOT_TOKEN").trim(),
    allowedUserId: pick("TELEGRAM_ALLOWED_USER_ID").trim(),
    chatId: pick("TELEGRAM_CHAT_ID").trim(),
    cdpUrl: pick("CDP_URL", "http://127.0.0.1:9222").replace(/\/$/, ""),
    pollIntervalMs: Number(pick("POLL_INTERVAL_MS", "2000")) || 2000,
    apiBase: pick("TELEGRAM_API_BASE", "https://api.telegram.org").replace(/\/$/, ""),
  };
}
