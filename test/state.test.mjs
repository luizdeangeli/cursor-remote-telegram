import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { selectorsBroken } from "../src/diagnostics.mjs";
import { acquireLock, HISTORY_LIMIT, loadState, pruneHistory, saveState } from "../src/state.mjs";

async function dir() {
  return mkdtemp(path.join(tmpdir(), "cursor-remote-"));
}

test("estado inválido é preservado e não vira estado vazio", async () => {
  const file = path.join(await dir(), "state.json");
  await writeFile(file, "{");
  await assert.rejects(() => loadState(file), /JSON|estado|objeto|Expected/i);
  const saved = await readFile(file, "utf8").catch(() => "");
  assert.equal(saved, "");
  const folder = await readFile(path.join(path.dirname(file), (await import("node:fs")).readdirSync(path.dirname(file)).find((name) => name.includes("corrupt"))), "utf8");
  assert.equal(folder, "{");
});

test("cópia válida recupera o estado sem apagar o arquivo inválido", async () => {
  const folder = await dir();
  const file = path.join(folder, "state.json");
  await saveState({ version: 2, topics: { "mercado::a": { threadId: 7, title: "mercado · a" } } }, file);
  await saveState({ version: 2, topics: { "mercado::a": { threadId: 7, title: "mercado · a" } }, chatId: "-1" }, file);
  await writeFile(file, "nao-json");
  const state = await loadState(file);
  assert.equal(state.recoveredFrom, "backup");
  assert.equal(state.topics["mercado::a"].threadId, 7);
  assert.match(state.quarantineFile, /corrupt-/);
});

test("gravação fica restrita ao usuário e a cópia não gira a cada escrita", async () => {
  const folder = await dir();
  const file = path.join(folder, "state.json");
  await saveState({ version: 2, topics: { a: { threadId: 1 } } }, file);
  await saveState({ version: 2, topics: { a: { threadId: 2 } } }, file);
  const firstBackup = await readFile(`${file}.bak1`, "utf8");
  await saveState({ version: 2, topics: { a: { threadId: 3 } } }, file);
  assert.equal(await readFile(`${file}.bak1`, "utf8"), firstBackup);
  assert.match(firstBackup, /"threadId": 1/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(`${file}.bak1`)).mode & 0o777, 0o600);
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
});

test("histórico antigo e excedente sai, conversa aberta permanece", () => {
  const now = Date.now();
  const state = { history: {}, topics: { aberta: { closed: false, retired: false } } };
  state.history.aberta = { messages: [{ text: "fica" }], updatedAt: now - 30 * 24 * 60 * 60 * 1000 };
  state.history.velha = { messages: [{ text: "sai" }], updatedAt: now - 15 * 24 * 60 * 60 * 1000 };
  state.history.viva = { messages: [{ text: "tela" }], updatedAt: now - 20 * 24 * 60 * 60 * 1000 };
  for (let index = 0; index < HISTORY_LIMIT; index += 1) {
    state.history[`extra-${index}`] = { messages: [], updatedAt: now - index * 1000 };
  }
  pruneHistory(state, { liveKeys: ["viva"], now });
  assert.equal(state.history.aberta.messages[0].text, "fica");
  assert.equal(state.history.viva.messages[0].text, "tela");
  assert.equal(state.history.velha, undefined);
  assert.equal(state.history["extra-0"].updatedAt, now);
  assert.equal(state.history["extra-29"], undefined);
  assert.equal(Object.keys(state.history).length, HISTORY_LIMIT);
});

test("seletor zerado ou inválido é falha de leitura", () => {
  const probe = { sidebarCells: 0, messageNodes: 0, composer: 0, barTabs: 0 };
  assert.equal(selectorsBroken({ probe }), true);
  assert.equal(selectorsBroken({ probe: { ...probe, composer: 1 } }), false);
  assert.equal(selectorsBroken({ error: "falhou", probe }), false);
  assert.equal(selectorsBroken({ probe: { ...probe, messageNodes: -1 } }), true);
  assert.equal(selectorsBroken({}), false);
});

test("segunda instância é recusada e bloqueio abandonado é recuperado", async () => {
  const file = path.join(await dir(), "bridge.lock");
  const first = await acquireLock(file, { isAlive: (pid) => pid === process.pid });
  assert.equal(first.acquired, true);
  await assert.rejects(() => acquireLock(file, { isAlive: () => true }), /já está em execução/);
  const recovered = await acquireLock(file, { isAlive: () => false });
  assert.equal(recovered.recovered, true);
});