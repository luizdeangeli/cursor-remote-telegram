import { readFile } from "node:fs/promises";
import path from "node:path";
import { CdpSession, listTargets } from "../src/cdp.mjs";
import { rootDir } from "../src/env.mjs";

const cdpUrl = process.env.CDP_URL || "http://127.0.0.1:9222";
const selectors = JSON.parse(await readFile(path.join(rootDir, "selectors.json"), "utf8"));
const targets = await listTargets(cdpUrl);
console.log(`alvos=${targets.length}`);
for (const target of targets) {
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.open();
  const census = await session.evaluate(`(() => {
    const count = (sel) => {
      try { return document.querySelectorAll(sel).length; } catch { return -1; }
    };
    const selectors = ${JSON.stringify(selectors)};
    return {
      title: document.title,
      url: location.href,
      input: selectors.chatInput.map((sel) => [sel, count(sel)]),
      messages: count(selectors.messages),
      tabs: selectors.tabs.map((sel) => [sel, count(sel)]),
      approve: selectors.approve.map((sel) => [sel, count(sel)]),
      lexical: count("[data-lexical-editor='true']"),
      composer: count("[data-composer-id]"),
      contenteditable: count("[contenteditable='true']"),
    };
  })()`);
  console.log(JSON.stringify({ id: target.id, title: target.title, census }, null, 2));
  session.close();
}

if (!targets.length) process.exitCode = 1;
