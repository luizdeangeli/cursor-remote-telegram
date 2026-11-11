import { diagnosticReport } from "../src/diagnostics.mjs";
import { loadConfig, validateConfig } from "../src/env.mjs";
import { loadState } from "../src/state.mjs";
import { classifyTelegramError, Telegram } from "../src/telegram.mjs";

const config = await loadConfig();
const errors = validateConfig(config);
let state = null;
try {
  state = await loadState();
} catch (error) {
  console.error(`Estado: ${error.message}`);
  if (error.quarantineFile) console.error(`Arquivo preservado em ${error.quarantineFile}`);
}

let windows = [];
let cursorError = "";
try {
  const response = await fetch(new URL("/json/version", config.cdpUrl.endsWith("/") ? config.cdpUrl : `${config.cdpUrl}/`), {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) cursorError = `HTTP ${response.status}`;
} catch (error) {
  cursorError = error.name === "TimeoutError" ? "tempo esgotado" : error.message;
}
if (cursorError) windows = [{ title: "Cursor", error: cursorError, tabs: [] }];

let permissions = null;
if (config.token && !errors.some((item) => item.includes("TELEGRAM_BOT_TOKEN"))) {
  try {
    const telegram = new Telegram(config.token, config.apiBase, { minIntervalMs: 0 });
    const me = await telegram.getMe();
    const chatId = config.chatId || state?.chatId;
    if (chatId && me?.id) {
      const member = await telegram.getChatMember(chatId, me.id);
      permissions = { canManageTopics: Boolean(member?.can_manage_topics || member?.status === "creator") };
    }
    telegram.stop();
  } catch (error) {
    const kind = classifyTelegramError(error);
    if (state) state.lastError = `Telegram (${kind}): ${error.message}`;
    else console.error(`Telegram (${kind}): ${error.message}`);
  }
}

const report = diagnosticReport({
  config,
  state: state || {},
  windows,
  permissions,
});
console.log(report);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
