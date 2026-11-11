import assert from "node:assert/strict";
import test from "node:test";
import { isWorkbench } from "../src/cdp.mjs";
import { chunkText, planOutbound, tabKey } from "../src/delivery.mjs";

test("corta texto longo na quebra de linha", () => {
  const text = `${"a".repeat(20)}\n${"b".repeat(20)}`;
  const chunks = chunkText(text, 25);
  assert.equal(chunks[0], "a".repeat(20));
  assert.equal(chunks[1], "b".repeat(20));
});

test("não envia a resposta final enquanto o agente trabalha", () => {
  const messages = [{ id: "1", role: "assistant", text: "ainda escrevendo" }];
  const running = planOutbound({ messages, status: "running", activity: "Trabalhando…", sent: [] });
  assert.equal(running.finals.length, 0);
  assert.match(running.progress, /Trabalhando/);
  const done = planOutbound({ messages, status: "idle", sent: [] });
  assert.equal(done.finals.length, 1);
  assert.equal(done.finals[0].text, "ainda escrevendo");
});

test("não manda o raciocínio do agente como mensagem", () => {
  const messages = [
    { id: "t1", role: "thinking", text: "Thought\n4s\n4s" },
    { id: "t2", role: "assistant", text: "Thinking" },
    { id: "a", role: "assistant", text: "O login do Google falhou no cookie." },
  ];
  const running = planOutbound({ messages, status: "running", activity: "Trabalhando…", sent: [] });
  assert.equal(running.finals.length, 0);
  assert.doesNotMatch(running.progress, /Thought|Thinking|Google/);
  const done = planOutbound({ messages, status: "idle", sent: [] });
  assert.equal(done.finals.length, 1);
  assert.match(done.finals[0].text, /Google/);
});

test("não repete o que já foi enviado nem o prompt vindo do Telegram", () => {
  const messages = [
    { id: "h", role: "human", text: "olá do telegram" },
    { id: "a", role: "assistant", text: "pronto" },
  ];
  const first = planOutbound({ messages, status: "idle", sent: [], ownPrompts: ["olá do telegram"] });
  assert.equal(first.echoes.length, 0);
  const second = planOutbound({
    messages,
    status: "idle",
    sent: first.finals.map((item) => item.hash),
    ownPrompts: ["olá do telegram"],
  });
  assert.equal(second.finals.length, 0);
});

test("a chave da aba usa o projeto e o id da conversa", () => {
  assert.equal(tabKey("mercado - Cursor", { id: "abc", title: "Auditoria" }), "mercado::abc");
  const tab = { id: "perfil", title: "perfil" };
  assert.equal(
    tabKey(".env - mercado - Cursor", tab),
    tabKey("Mercado Demo - mercado - Cursor", tab),
  );
});

test("ignora páginas que não são o Cursor", () => {
  assert.equal(isWorkbench({ type: "page", url: "devtools://inspect", webSocketDebuggerUrl: "ws://x" }), false);
  assert.equal(isWorkbench({
    type: "page",
    url: "vscode-file://vscode-app/workbench.html",
    webSocketDebuggerUrl: "ws://x",
  }), true);
});
