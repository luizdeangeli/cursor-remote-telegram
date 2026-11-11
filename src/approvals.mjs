import { randomBytes } from "node:crypto";
import { fingerprint } from "./delivery.mjs";

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export function approvalHash(approval) {
  return fingerprint(`${approval?.command || ""}\n${approval?.label || ""}`);
}

export function createApprovalToken({
  key,
  approval,
  threadId,
  chatId,
  project,
  conversation,
  now = Date.now(),
}) {
  return {
    id: randomBytes(5).toString("hex"),
    key,
    hash: approvalHash(approval),
    index: approval?.index || 0,
    command: approval?.command || approval?.label || "",
    label: approval?.label || "",
    threadId: threadId || 0,
    chatId: String(chatId || ""),
    project: project || "",
    conversation: conversation || "",
    createdAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    status: "pending",
    ownerPid: 0,
  };
}

export function judgeCallback({
  token,
  userId,
  expectedUserId,
  chatId,
  expectedChatId,
  now = Date.now(),
}) {
  if (!expectedUserId || String(userId) !== String(expectedUserId)) {
    return { ok: false, message: "Sem permissão" };
  }
  if (!chatId || String(chatId) !== String(expectedChatId)) {
    return { ok: false, message: "Sem permissão" };
  }
  if (!token) return { ok: false, message: "Esse pedido expirou" };
  if (token.chatId && String(chatId) !== String(token.chatId)) {
    return { ok: false, message: "Sem permissão" };
  }
  if (token.status === "em_execucao" || token.status === "consumed" || token.status === "uncertain") {
    return { ok: false, message: "Esse pedido já foi usado" };
  }
  if (token.status !== "pending") return { ok: false, message: "Esse pedido expirou" };
  if (token.expiresAt && now > token.expiresAt) return { ok: false, message: "Esse pedido expirou" };
  return { ok: true };
}

export function approvalStillMatches(token, approvals) {
  const list = approvals || [];
  const current = list.find((item) => approvalHash(item) === token?.hash);
  return Boolean(current);
}

export function reconcileTokens(tokens, now, pid) {
  const notes = [];
  for (const token of Object.values(tokens || {})) {
    if (!token) continue;
    if (token.status === "em_execucao" && token.ownerPid !== pid) {
      token.status = "uncertain";
      token.error = "A aprovação foi interrompida. Não repeti o clique.";
      notes.push(token);
    } else if (token.status === "pending" && token.expiresAt && token.expiresAt <= now) {
      token.status = "invalid";
      notes.push(token);
    }
  }
  return notes;
}
