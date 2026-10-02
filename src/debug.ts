import { getRootElement } from "./rootElement";
import { t } from "./i18n";

let panel: HTMLElement | null = null;
let logList: HTMLElement | null = null;
let fpsEl: HTMLElement | null = null;
let visible = false;

function ensurePanel(): void {
  if (panel) {
    const root = getRootElement();
    if (panel.parentElement !== root) root.appendChild(panel);
    return;
  }

  panel = document.createElement("div");
  panel.id = "debug-console";

  const header = document.createElement("div");
  header.className = "debug-header";

  const title = document.createElement("span");
  title.textContent = t("Debug Console");

  const clearBtn = document.createElement("button");
  clearBtn.textContent = t("Clear");
  clearBtn.addEventListener("click", () => {
    if (logList) logList.innerHTML = "";
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = t("Close");
  closeBtn.addEventListener("click", () => toggle());

  header.append(title, clearBtn, closeBtn);

  fpsEl = document.createElement("div");
  fpsEl.className = "debug-fps";
  fpsEl.textContent = "FPS: --";

  logList = document.createElement("div");
  logList.className = "debug-log-list";

  panel.append(header, fpsEl, logList);
  getRootElement().appendChild(panel);

  document.addEventListener("keydown", (e) => {
    if (e.key === "`" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // e.target is retargeted to the shadow host; the real origin is composedPath()[0].
      const target = e.composedPath()[0] as HTMLElement | undefined;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      e.preventDefault();
      toggle();
    }
  });
}

function toggle(): void {
  ensurePanel();
  visible = !visible;
  panel!.classList.toggle("visible", visible);
}

export function debugLog(category: string, message: string, data?: string): void {
  ensurePanel();
  if (!logList) return;

  const entry = document.createElement("div");
  entry.className = "debug-entry";

  const time = new Date().toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 1 });
  const timeSpan = document.createElement("span");
  timeSpan.className = "debug-time";
  timeSpan.textContent = time;

  const catSpan = document.createElement("span");
  catSpan.className = "debug-category";
  catSpan.textContent = category;

  const msgSpan = document.createElement("span");
  msgSpan.className = "debug-message";
  msgSpan.textContent = message;

  entry.append(timeSpan, catSpan, msgSpan);

  if (data) {
    const dataSpan = document.createElement("span");
    dataSpan.className = "debug-data";
    dataSpan.textContent = data;
    entry.appendChild(dataSpan);
  }

  logList.appendChild(entry);
  logList.scrollTop = logList.scrollHeight;

  while (logList.children.length > 500) {
    logList.removeChild(logList.firstChild!);
  }
}

let frameCount = 0;
let lastFpsTime = 0;
let lastFrameTime = 0;

export function updateFps(now: number): void {
  if (!fpsEl) return;
  if (lastFpsTime === 0) {
    // First frame after init or idle: start a fresh measurement window.
    lastFpsTime = now;
    lastFrameTime = now;
    frameCount = 0;
    return;
  }
  frameCount++;
  const frameTime = lastFrameTime ? now - lastFrameTime : 0;
  lastFrameTime = now;

  if (now - lastFpsTime >= 500) {
    const elapsed = now - lastFpsTime;
    const fps = Math.round((frameCount / elapsed) * 1000);
    fpsEl.textContent = t("FPS: {fps}  |  Frame: {ms}ms", { fps, ms: frameTime.toFixed(1) });
    frameCount = 0;
    lastFpsTime = now;
  }
}

export function markFpsIdle(): void {
  if (fpsEl) fpsEl.textContent = t("FPS: idle");
  lastFpsTime = 0;
  lastFrameTime = 0;
  frameCount = 0;
}

export function initDebugConsole(): void {
  ensurePanel();
  debugLog(t("system"), t("Debug console initialized"));
}
