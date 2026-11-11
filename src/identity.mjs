import { projectName, tabKey } from "./delivery.mjs";

export function annotateWindows(windows) {
  const groups = new Map();
  for (const window of windows) {
    if (window.error) continue;
    window.projectName = projectName(window.title || "");
    const list = groups.get(window.projectName) || [];
    list.push(window);
    groups.set(window.projectName, list);
  }
  for (const window of windows) {
    if (window.error) continue;
    const siblings = groups.get(window.projectName) || [];
    const paths = new Set(siblings.map((item) => item.workspacePath).filter(Boolean));
    window.distinguished = siblings.length > 1 && paths.size === siblings.length;
    window.projectAmbiguous = siblings.length > 1 && !window.distinguished;
  }
  return windows;
}

export function storageKey(window, tab) {
  const id = tab?.id || tab?.title || "ativa";
  if (window.projectAmbiguous) return `${tabKey(window.title, tab)}::win:${window.targetId}`;
  if (window.distinguished && window.workspacePath) return `${window.workspacePath}::${id}`;
  return tabKey(window.title, tab);
}

function sameProject(topic, tab) {
  if (topic.workspacePath && tab.workspacePath) return topic.workspacePath === tab.workspacePath;
  if (topic.projectName && tab.projectName) return topic.projectName === tab.projectName;
  if (tab.projectName && String(topic.title || "").startsWith(`${tab.projectName} ·`)) return true;
  return false;
}

export function findExistingTopic(topics, tab) {
  const entries = Object.entries(topics || {}).filter(([, topic]) => topic && !topic.retired);
  if (tab.stableId) {
    const found = entries.filter(([, topic]) => topic.stableId === tab.stableId && sameProject(topic, tab));
    if (found.length >= 1) return found.sort((a, b) => (b[1].threadId || 0) - (a[1].threadId || 0))[0][0];
  }
  if (topics?.[tab.key] && !topics[tab.key].retired) return tab.key;
  const byTitle = entries.filter(([, topic]) => {
    if (topic.stableId && tab.stableId && topic.stableId !== tab.stableId) return false;
    return topic.title === tab.title && sameProject(topic, tab);
  });
  if (byTitle.length >= 1) return byTitle.sort((a, b) => (b[1].threadId || 0) - (a[1].threadId || 0))[0][0];
  return "";
}
