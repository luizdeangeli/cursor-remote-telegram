function ageOf(timestamp, now) {
  if (!timestamp) return "nunca";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 90) return `há ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `há ${minutes} min`;
  return `há ${Math.round(minutes / 60)} h`;
}

function countStatus(operations, status) {
  return (operations || []).filter((op) => op.status === status).length;
}

export function nextStep({ windows = [], config = {}, state = {} }) {
  if (!config.token) return "Preencha TELEGRAM_BOT_TOKEN no .env.";
  if (!config.allowedUserId && !state.allowedUserId) {
    return "Pareie a conta: envie /parear com o código impresso no terminal.";
  }
  if (!config.chatId && !state.chatId) {
    return "Pareie o grupo: envie /parear com o código impresso no terminal.";
  }
  if (!windows.length) return "Feche o Cursor pelo menu e abra de novo com bin/cursor-debug.";
  if (windows.every((window) => window.error)) {
    return "A porta respondeu, mas a leitura da janela falhou. Rode npm run probe.";
  }
  if (windows.some((window) => window.projectAmbiguous)) {
    return "Há projetos com o mesmo nome de pasta. Abra um de cada vez ou exponha o caminho do workspace.";
  }
  const incomplete = windows.some((window) => window.tabsIncomplete || window.listReliable === false);
  if (incomplete) return "A lista de conversas veio incompleta. Deixe as abas fora de More e envie /recarregar.";
  if ((state.operations || []).some((op) => op.status === "resultado_incerto")) {
    return "Há resultado incerto. Confira a conversa no Cursor antes de pedir de novo. A ponte não reenvia sozinha.";
  }
  if (state.lastError) return "O último erro está acima. Corrija essa causa e envie /diagnostico de novo.";
  return "Nenhum bloqueio detectado. Envie um prompt no tópico da conversa para testar.";
}

export function selectorsBroken(window) {
  const probe = window?.probe;
  if (!window || window.error || !probe) return false;
  const values = [probe.sidebarCells, probe.messageNodes, probe.composer, probe.barTabs];
  if (values.some((value) => value < 0)) return true;
  return values.every((value) => value === 0);
}

export function selectorFindings(windows = []) {
  if (!windows.length) return ["Seletores: nenhuma janela para conferir."];
  const lines = [];
  for (const window of windows) {
    const name = window.projectName || window.title || "janela";
    if (window.error) {
      lines.push(`Seletores em ${name}: leitura falhou (${window.error}).`);
      continue;
    }
    if (window.composerFound === false) lines.push(`Seletores em ${name}: campo do agente ausente.`);
    if (!window.tabs?.length) lines.push(`Seletores em ${name}: nenhuma conversa encontrada.`);
    if (window.tabsIncomplete) lines.push(`Seletores em ${name}: a lista parece incompleta (More).`);
  }
  return lines.length ? lines : ["Seletores: campo do agente e conversas encontrados na última leitura."];
}

export function diagnosticReport({ config = {}, state = {}, windows = [], now = Date.now(), permissions = null }) {
  const topics = Object.values(state.topics || {});
  const closed = topics.filter((topic) => topic.closed).length;
  const ambiguous = topics.filter((topic) => topic.ambiguous).length;
  const linked = topics.length - closed - ambiguous;
  const pending = countStatus(state.operations, "pendente") + countStatus(state.operations, "recebida");
  const lines = [
    "Diagnóstico",
    windows.some((window) => !window.error) ? "Cursor: leitura ok" : "Cursor: sem leitura utilizável",
    `Telegram: token ${config.token ? "definido" : "ausente"}`,
    `Usuário: ${config.allowedUserId || state.allowedUserId || "não pareado"}`,
    `Chat: ${config.chatId || state.chatId || "não pareado"}`,
    `Tópicos: ${state.forum === false ? "não" : state.forum === true ? "sim" : "ainda não verificado"}`,
    permissions == null
      ? "Permissão de tópicos: ainda não consultada"
      : `Permissão de tópicos: ${permissions.canManageTopics ? "sim" : "não"}`,
    `Última leitura do Cursor: ${ageOf(state.lastCursorReadAt, now)}`,
    `Conversas ligadas: ${linked}; fechadas: ${closed}; ambíguas: ${ambiguous}`,
    "Leitura ao vivo: só a conversa visível de cada janela. As outras não estão ociosas; estão sem leitura.",
    `Fila: pendentes ${pending}; em execução ${countStatus(state.operations, "em_execucao")}; falhas ${countStatus(state.operations, "falhou")}; incertos ${countStatus(state.operations, "resultado_incerto")}`,
  ];
  if (state.recoveredFrom) lines.push("O estado atual veio de uma cópia de recuperação.");
  if (state.lastError) lines.push(`Último erro: ${String(state.lastError).slice(0, 300)}`);
  lines.push(...selectorFindings(windows));
  const visible = windows.filter((window) => !window.error);
  if (visible.length) {
    lines.push("Janelas:");
    for (const window of visible) {
      const mark = window.projectAmbiguous ? " ambíguo" : "";
      lines.push(`• ${window.title} (${window.status || "?"}${mark})`);
    }
  }
  lines.push(`Próximo passo: ${nextStep({ windows, config, state })}`);
  return lines.join("\n");
}
