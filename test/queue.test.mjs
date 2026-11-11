import assert from "node:assert/strict";
import test from "node:test";
import { admitOperation, isRunnable, operationId, reconcileOperations } from "../src/queue.mjs";
import { judgeCallback } from "../src/approvals.mjs";
import { resolveDestination } from "../src/routing.mjs";

test("retransmissão não cria outra operação e textos iguais continuam distintos", () => {
  const now = 1_000;
  const first = { id: operationId(1, "prompt", 20), status: "recebida", createdAt: now, updatedAt: now, expiresAt: now + 1000 };
  const again = admitOperation([first], { ...first }, now);
  assert.equal(again.duplicate, true);
  assert.equal(again.operations.length, 1);
  const second = admitOperation(again.operations, {
    id: operationId(2, "prompt", 20),
    status: "recebida",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 1000,
  }, now);
  assert.equal(second.duplicate, false);
  assert.equal(second.operations.length, 2);
});

test("execução interrompida vira resultado incerto e não fica executável", () => {
  const op = { id: "1", status: "em_execucao", ownerPid: 4, expiresAt: Date.now() + 1000 };
  const notes = reconcileOperations([op], Date.now(), 9);
  assert.equal(notes.length, 1);
  assert.equal(op.status, "resultado_incerto");
  assert.equal(isRunnable(op), false);
});

test("tópico desconhecido não escolhe a aba ativa", () => {
  const result = resolveDestination({
    threadId: 99,
    forum: true,
    topics: { "mercado::a": { threadId: 20, title: "A" } },
    tabs: [{ key: "mercado::a", active: true, title: "A" }],
    purpose: "prompt",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_topic");
});

test("callback de outro chat não autoriza o clique", () => {
  const verdict = judgeCallback({
    token: { status: "pending", chatId: "-1001", expiresAt: Date.now() + 1000 },
    userId: 42,
    expectedUserId: 42,
    chatId: "-2000",
    expectedChatId: "-1001",
  });
  assert.equal(verdict.ok, false);
});