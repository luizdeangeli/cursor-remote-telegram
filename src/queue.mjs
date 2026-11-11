// A fila vive no mesmo JSON do estado, no mesmo processo e sob o mesmo
// bloqueio de instância. A gravação atômica (arquivo temporário + rename)
// confirma o offset do Telegram e a operação no mesmo documento. Isso não
// é execução exatamente uma vez: o Cursor e o Telegram não oferecem essa
// garantia. Resultado incerto não é reenviado sem reconciliação.

export const MAX_OPERATIONS = 200;
export const OPERATION_TTL_MS = 30 * 60 * 1000;
export const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

const TERMINAL = new Set(["confirmada", "falhou", "resultado_incerto"]);

export function operationId(updateId, kind, destination) {
  return `${updateId}:${kind}:${destination}`;
}

export function pruneOperations(operations, now) {
  return (operations || []).filter((op) => {
    if (!op) return false;
    if (!TERMINAL.has(op.status)) return true;
    return (op.updatedAt || op.createdAt || 0) >= now - TERMINAL_RETENTION_MS;
  });
}

export function admitOperation(operations, op, now) {
  const pruned = pruneOperations(operations, now);
  const existing = pruned.find((item) => item.id === op.id);
  if (existing) return { operations: pruned, operation: existing, duplicate: true, full: false };
  const active = pruned.filter((item) => !TERMINAL.has(item.status));
  if (active.length >= MAX_OPERATIONS) {
    return { operations: pruned, operation: null, duplicate: false, full: true };
  }
  return { operations: [...pruned, op], operation: op, duplicate: false, full: false };
}

export function reconcileOperations(operations, now, pid) {
  const notes = [];
  for (const op of operations || []) {
    if (op.status === "em_execucao" && op.ownerPid !== pid) {
      op.status = "resultado_incerto";
      op.error = "A execução foi interrompida. Não repeti a ação.";
      op.updatedAt = now;
      notes.push(op);
    } else if ((op.status === "recebida" || op.status === "pendente") && op.expiresAt && op.expiresAt <= now) {
      op.status = "falhou";
      op.error = "Pedido expirado antes da execução.";
      op.updatedAt = now;
      notes.push(op);
    }
  }
  return notes;
}

export function isRunnable(op, now = Date.now()) {
  if (!op) return false;
  if (op.status !== "recebida" && op.status !== "pendente") return false;
  if (op.expiresAt && op.expiresAt <= now) return false;
  return true;
}
