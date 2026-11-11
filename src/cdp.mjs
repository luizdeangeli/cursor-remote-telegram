export function isWorkbench(target) {
  const url = target.url || "";
  const title = target.title || "";
  if (!target.webSocketDebuggerUrl) return false;
  if (target.type !== "page") return false;
  if (url.startsWith("devtools://")) return false;
  if (url.includes("workbench") || url.startsWith("vscode-file://")) return true;
  return /cursor/i.test(title);
}

export async function listTargets(cdpUrl) {
  const response = await fetch(new URL("/json/list", cdpUrl.endsWith("/") ? cdpUrl : `${cdpUrl}/`));
  if (!response.ok) throw new Error(`CDP respondeu ${response.status}`);
  const targets = await response.json();
  return targets.filter(isWorkbench);
}

export class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  open() {
    this.ws = new WebSocket(this.wsUrl);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("tempo esgotado ao abrir o CDP")), 8000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("falha ao conectar no CDP"));
      }, { once: true });
      this.ws.addEventListener("message", (event) => this.#onMessage(event.data));
      this.ws.addEventListener("close", () => {
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("conexão CDP fechada"));
          this.pending.delete(id);
        }
      });
    });
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id == null || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "erro CDP"));
    else pending.resolve(message.result);
  }

  call(method, params = {}, timeoutMs = 15000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP desconectado"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`tempo esgotado em ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(detail || "falha ao ler a página");
    }
    return result.result?.value;
  }

  insertText(text) {
    return this.call("Input.insertText", { text });
  }

  async pressKey(key, code, vk, modifiers = 0) {
    const base = {
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
    };
    await this.call("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async screenshot() {
    try {
      await this.call("Page.enable");
    } catch {
      // A página já pode ter o domínio habilitado.
    }
    const result = await this.call("Page.captureScreenshot", { format: "png" });
    return Buffer.from(result.data, "base64");
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Já fechado.
    }
  }
}
