import type { HaState } from "../ha/types";
import { getRootElement } from "../rootElement";
import { t } from "../i18n";

let tooltipEl: HTMLDivElement | null = null;

function ensureTooltip(): HTMLDivElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "tooltip";
  }
  const root = getRootElement();
  if (tooltipEl.parentElement !== root) root.appendChild(tooltipEl);
  return tooltipEl;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function showTooltip(
  x: number,
  y: number,
  label: string,
  entityId: string | undefined,
  states: Map<string, HaState>,
  extraHtml?: string,
): void {
  const el = ensureTooltip();

  let html = `<strong>${escapeHtml(label)}</strong>`;

  if (entityId) {
    const state = states.get(entityId);
    html += `<br><span class="tooltip-id">${escapeHtml(entityId)}</span>`;
    if (state) {
      html += `<br>${t("State: ")}<strong>${escapeHtml(state.state)}</strong>`;
      const changed = new Date(state.last_changed);
      html += `<br>${t("Changed: ")}${changed.toLocaleString()}`;
    }
  }

  // extraHtml is built by callers and trusted; they must escape their own data.
  if (extraHtml) {
    html += extraHtml;
  }

  el.innerHTML = html;
  el.style.display = "block";

  const rootRect = getRootElement().getBoundingClientRect();
  const localX = x - rootRect.left;
  const localY = y - rootRect.top;

  const padding = 12;
  let left = localX + padding;
  let top = localY + padding;

  const rect = el.getBoundingClientRect();
  if (left + rect.width > rootRect.width) {
    left = localX - rect.width - padding;
  }
  if (top + rect.height > rootRect.height) {
    top = localY - rect.height - padding;
  }

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

export function hideTooltip(): void {
  if (tooltipEl) {
    tooltipEl.style.display = "none";
  }
}
