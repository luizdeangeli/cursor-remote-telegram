import assert from "node:assert/strict";
import test from "node:test";
import { backoffMs, classifyTelegramError } from "../src/telegram.mjs";

test("classifica token, permissão, destino, limite e tempo esgotado", () => {
  assert.equal(classifyTelegramError({ code: 401 }), "invalid_token");
  assert.equal(classifyTelegramError({ code: 403, message: "not enough rights" }), "permission");
  assert.equal(classifyTelegramError({ code: 400, message: "message thread not found" }), "missing_destination");
  assert.equal(classifyTelegramError({ code: 429 }), "rate_limit");
  assert.equal(classifyTelegramError({ name: "TimeoutError" }), "temporary");
  assert.equal(classifyTelegramError({ code: 500 }), "temporary");
});

test("a espera cresce e fica limitada", () => {
  const first = backoffMs(0, 500, 1000);
  const later = backoffMs(8, 500, 1000);
  assert.ok(first >= 500 && first < 750);
  assert.ok(later >= 1000 && later < 1250);
});