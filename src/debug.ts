let panel: HTMLElement | null = null;
let logList: HTMLElement | null = null;
let visible = false;

function ensurePanel(): void {
  if (panel) return;

  panel = document.createElement("div");
  panel.id = "debug-console";

  const header = document.createElement("div");
  header.className = "debug-header";

  const title = document.createElement("span");
  title.textContent = "Debug Console";

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear";
  clearBtn.addEventListener("click", () => {
    if (logList) logList.innerHTML = "";
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => toggle());

  header.append(title, clearBtn, closeBtn);

  logList = document.createElement("div");
  logList.className = "debug-log-list";

  panel.append(header, logList);
  document.body.appendChild(panel);

  document.addEventListener("keydown", (e) => {
    if (e.key === "`" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
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

export function initDebugConsole(): void {
  ensurePanel();
  debugLog("system", "Debug console initialized");
}
