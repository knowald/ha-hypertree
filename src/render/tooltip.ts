import type { HaState } from "../ha/types";
import { getRootElement } from "../rootElement";

let tooltipEl: HTMLDivElement | null = null;

function ensureTooltip(): HTMLDivElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "tooltip";
    getRootElement().appendChild(tooltipEl);
  }
  return tooltipEl;
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

  let html = `<strong>${label}</strong>`;

  if (entityId) {
    const state = states.get(entityId);
    html += `<br><span class="tooltip-id">${entityId}</span>`;
    if (state) {
      html += `<br>State: <strong>${state.state}</strong>`;
      const changed = new Date(state.last_changed);
      html += `<br>Changed: ${changed.toLocaleString()}`;
    }
  }

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
