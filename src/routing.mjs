export function resolveDestination({
  threadId = 0,
  forum,
  topics = {},
  tabs = [],
  activeTabKey = "",
  purpose = "prompt",
} = {}) {
  const inTopic = forum !== false && threadId && Number(threadId) !== 1;
  if (inTopic) {
    const matches = Object.entries(topics).filter(([, topic]) => topic && topic.threadId === threadId);
    if (!matches.length) {
      return {
        ok: false,
        reason: "unknown_topic",
        message: "Este tópico não está ligado a uma conversa. No General, envie /recarregar para restabelecer o vínculo.",
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        message: "Este tópico está ligado a mais de uma conversa. Não escolhi nenhuma. No General, envie /recarregar.",
      };
    }
    const [key, topic] = matches[0];
    if (topic.ambiguous) {
      return {
        ok: false,
        reason: "ambiguous",
        message: "O vínculo desta conversa está ambíguo. Há nomes iguais ou projetos com a mesma pasta. Separe os nomes e envie /recarregar no General.",
      };
    }
    if (topic.retired) {
      return {
        ok: false,
        reason: "retired",
        message: "Este tópico não é mais o vínculo desta conversa. O histórico foi mantido. Use o tópico atual.",
      };
    }
    if (topic.closed) {
      return {
        ok: false,
        reason: "closed",
        message: "Esta conversa não está aberta no Cursor. O histórico deste tópico foi mantido. Abra a conversa e envie /recarregar no General.",
      };
    }
    const live = tabs.filter((tab) => tab.key === key && !tab.missing);
    if (!live.length) {
      return {
        ok: false,
        reason: "missing",
        message: "Não achei essa conversa aberta no Cursor. Abra a conversa e envie /recarregar no General.",
      };
    }
    if (live.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        message: "Há mais de uma conversa com este vínculo. Não escolhi nenhuma.",
      };
    }
    return { ok: true, key, topic, tab: live[0], scope: "topic" };
  }

  if (forum === false) {
    const tab = tabs.find((item) => item.key === activeTabKey);
    if (!activeTabKey || !tab) {
      return {
        ok: false,
        reason: "no_selection",
        message: "Nenhuma conversa escolhida. Use /abas e /usar N.",
      };
    }
    return { ok: true, key: tab.key, tab, scope: "selection" };
  }

  if (purpose === "screenshot" || purpose === "stop" || purpose === "history") {
    const tab = tabs.find((item) => item.active && item.window && !item.missing && !item.ambiguous);
    if (!tab) {
      const blocked = tabs.find((item) => item.active && item.ambiguous);
      if (blocked) {
        return {
          ok: false,
          reason: "ambiguous",
          message: "A conversa visível está ambígua. Não vou agir nela. Separe os nomes dos projetos ou das conversas.",
        };
      }
      return {
        ok: false,
        reason: "no_selection",
        message: purpose === "screenshot"
          ? "Nenhuma janela ativa para capturar."
          : "Nenhuma conversa ativa.",
      };
    }
    return { ok: true, key: tab.key, tab, scope: "current_window" };
  }

  return {
    ok: false,
    reason: "general",
    message: "Escreva dentro do tópico da aba. Os botões do menu ficam no General.",
  };
}
