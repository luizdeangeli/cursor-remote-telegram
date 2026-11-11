import { chmod, copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { rootDir } from "./env.mjs";

export const STATE_VERSION = 2;
export const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
export const HISTORY_LIMIT = 30;
export const HISTORY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const BACKUPS = 3;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function emptyState() {
  return {
    version: STATE_VERSION,
    updateOffset: 0,
    chatId: "",
    allowedUserId: "",
    pairingCode: "",
    forum: null,
    activeTabKey: "",
    topics: {},
    shared: {},
    sent: {},
    progress: {},
    approvals: {},
    approvalTokens: {},
    ownPrompts: {},
    operations: [],
    history: {},
    outbound: {},
    forgetTokens: {},
    cdpDownNotified: false,
    telegramDownNotified: false,
    tokenInvalidNotified: false,
    selectorsBrokenNotified: false,
    lastCursorReadAt: 0,
    lastError: "",
    ambiguityNotified: {},
    recoveredFrom: "",
    quarantineFile: "",
  };
}

export function statePath(file = path.join(rootDir, "data", "state.json")) {
  return file;
}

export function validateState(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "O arquivo de estado não contém um objeto." };
  }
  if (parsed.version != null && !Number.isInteger(parsed.version)) {
    return { ok: false, error: "A versão do estado não é um número inteiro." };
  }
  if (parsed.topics != null && (typeof parsed.topics !== "object" || Array.isArray(parsed.topics))) {
    return { ok: false, error: "O campo topics está inválido." };
  }
  if (parsed.operations != null && !Array.isArray(parsed.operations)) {
    return { ok: false, error: "O campo operations está inválido." };
  }
  return { ok: true, state: parsed };
}

export function migrateState(parsed) {
  if (Number.isInteger(parsed.version) && parsed.version > STATE_VERSION) {
    throw new Error(`versão de estado não suportada (${parsed.version})`);
  }
  const state = { ...emptyState(), ...parsed, version: STATE_VERSION };
  for (const key of ["topics", "shared", "sent", "progress", "approvals", "approvalTokens", "ownPrompts", "history", "outbound", "forgetTokens", "ambiguityNotified"]) {
    if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) state[key] = {};
  }
  if (!Array.isArray(state.operations)) state.operations = [];
  return state;
}

async function quarantine(file, raw) {
  const dest = `${file}.corrupt-${Date.now()}`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(dest, raw);
  await unlink(file).catch(() => {});
  return dest;
}

async function readValid(file) {
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  const validated = validateState(parsed);
  if (!validated.ok) throw new Error(validated.error);
  return migrateState(validated.state);
}

async function loadBackup(file) {
  for (let index = 1; index <= BACKUPS; index += 1) {
    try {
      return await readValid(`${file}.bak${index}`);
    } catch (error) {
      if (error.code === "ENOENT") continue;
    }
  }
  return null;
}

export async function loadState(file = statePath()) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    const validated = validateState(parsed);
    if (!validated.ok) throw new Error(validated.error);
    return migrateState(validated.state);
  } catch (error) {
    const quarantineFile = await quarantine(file, raw);
    const backup = await loadBackup(file);
    if (backup) {
      backup.recoveredFrom = "backup";
      backup.quarantineFile = quarantineFile;
      return backup;
    }
    error.quarantineFile = quarantineFile;
    throw error;
  }
}

export function pruneHistory(state, { liveKeys = [], now = Date.now() } = {}) {
  const history = state?.history;
  if (!history || typeof history !== "object" || Array.isArray(history)) return;
  const live = new Set(liveKeys);
  const topics = state.topics || {};
  const pinned = (key) => live.has(key) || (topics[key] && !topics[key].closed && !topics[key].retired);
  for (const key of Object.keys(history)) {
    if (pinned(key)) continue;
    const updatedAt = history[key]?.updatedAt || 0;
    if (!updatedAt || now - updatedAt > HISTORY_MAX_AGE_MS) delete history[key];
  }
  const extra = Object.keys(history)
    .filter((key) => !pinned(key))
    .sort((a, b) => (history[a]?.updatedAt || 0) - (history[b]?.updatedAt || 0));
  let count = Object.keys(history).length;
  for (const key of extra) {
    if (count <= HISTORY_LIMIT) break;
    delete history[key];
    count -= 1;
  }
}

async function rotateBackups(file) {
  for (let index = BACKUPS; index >= 2; index -= 1) {
    try {
      await rename(`${file}.bak${index - 1}`, `${file}.bak${index}`);
      await chmod(`${file}.bak${index}`, FILE_MODE);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  try {
    await copyFile(file, `${file}.bak1`);
    await chmod(`${file}.bak1`, FILE_MODE);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function backupIsStale(file) {
  try {
    const info = await stat(`${file}.bak1`);
    return Date.now() - info.mtimeMs >= BACKUP_INTERVAL_MS;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function syncDirectory(file) {
  const handle = await open(path.dirname(file), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function saveState(state, file = statePath()) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: DIR_MODE });
  await chmod(directory, DIR_MODE);
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await open(tmp, "w", FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(tmp, FILE_MODE);
  if (await backupIsStale(file)) await rotateBackups(file);
  await rename(tmp, file);
  await chmod(file, FILE_MODE);
  await syncDirectory(file);
}

export function processIsAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function acquireLock(file, { isAlive = processIsAlive } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
  try {
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(payload);
      await handle.chmod(FILE_MODE);
    } finally {
      await handle.close();
    }
    return { acquired: true, recovered: false };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let existing = {};
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch {
    existing = {};
  }
  if (isAlive(existing.pid)) {
    throw new Error(`Outra ponte já está em execução (pid ${existing.pid || "?"}). Encerre essa instância antes de iniciar outra.`);
  }
  await unlink(file).catch(() => {});
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(payload);
    await handle.chmod(FILE_MODE);
  } finally {
    await handle.close();
  }
  return { acquired: true, recovered: true, abandonedPid: existing.pid || 0 };
}

export async function releaseLock(file) {
  try {
    const existing = JSON.parse(await readFile(file, "utf8"));
    if (existing.pid !== process.pid) return;
  } catch (error) {
    if (error.code === "ENOENT") return;
    return;
  }
  await unlink(file).catch(() => {});
}
