import { getRootElement } from "./rootElement";

export function showStatusBar(text: string): void {
  removeStatusBar();
  const statusEl = document.createElement("div");
  statusEl.id = "status";
  statusEl.textContent = text;
  getRootElement().appendChild(statusEl);
}

export function removeStatusBar(): void {
  getRootElement().querySelector("#status")?.remove();
}

export function setStatusDisconnected(disconnected: boolean): void {
  const statusEl = getRootElement().querySelector("#status") as HTMLElement | null;
  if (!statusEl) return;
  if (disconnected) {
    if (statusEl.classList.contains("disconnected")) return;
    statusEl.classList.add("disconnected");
    statusEl.dataset.idleText = statusEl.textContent ?? "";
    statusEl.textContent = "Connection lost, reconnecting...";
  } else {
    statusEl.classList.remove("disconnected");
    if (statusEl.dataset.idleText !== undefined) {
      statusEl.textContent = statusEl.dataset.idleText;
      delete statusEl.dataset.idleText;
    }
  }
}
