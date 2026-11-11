import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { rootDir } from "./env.mjs";

export function emptyState() {
  return {
    updateOffset: 0,
    chatId: "",
    allowedUserId: "",
    forum: null,
    activeTabKey: "",
    topics: {},
    sent: {},
    progress: {},
    approvals: {},
    ownPrompts: {},
    cdpDownNotified: false,
  };
}

export function statePath(file = path.join(rootDir, "data", "state.json")) {
  return file;
}

export async function loadState(file = statePath()) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return { ...emptyState(), ...parsed };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyState();
  }
}

export async function saveState(state, file = statePath()) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, file);
}
