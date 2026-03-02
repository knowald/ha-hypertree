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
  states: Map<string, HaState>
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

  el.innerHTML = html;
  el.style.display = "block";

  const padding = 12;
  let left = x + padding;
  let top = y + padding;

  const rect = el.getBoundingClientRect();
  if (left + rect.width > window.innerWidth) {
    left = x - rect.width - padding;
  }
  if (top + rect.height > window.innerHeight) {
    top = y - rect.height - padding;
  }

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

export function hideTooltip(): void {
  if (tooltipEl) {
    tooltipEl.style.display = "none";
  }
}
