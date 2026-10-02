import { t } from "./i18n";

export interface LoginCredentials {
  url: string;
  token: string;
}

const STORAGE_KEY = "ha-hypertree-credentials";

export function renderLoginForm(
  container: HTMLElement,
  onSubmit: (creds: LoginCredentials) => void
): void {
  const saved = loadCredentials();

  container.innerHTML = `
    <form id="login-form">
      <img src="/icon.png" alt="" width="64" height="64" class="login-icon" />
      <h1>HA Hypertree</h1>
      <p>${t("Connect to your Home Assistant instance")}</p>
      <label>
        ${t("Home Assistant URL")}
        <input type="url" id="ha-url" placeholder="https://homeassistant.local:8123" required />
      </label>
      <label>
        ${t("Long-Lived Access Token")}
        <input type="password" id="ha-token" placeholder="eyJhbGciOi..." required />
      </label>
      <p id="protocol-warning" class="protocol-warning" hidden></p>
      <button type="submit">${t("Connect")}</button>
      <p id="login-error" class="error" hidden></p>
      ${import.meta.env.VITE_HIDE_EXPLAINER !== "true" ? `
      <details class="token-explainer">
        <summary>${t("Hold on, should I give you my token?")}</summary>
        <p>
          ${t("Darn it, no, but I almost got you.")}
        </p>
        <p>
          ${t("Just kidding - but seriously,")}
          ${t("never lose that reflex.")}
        </p>
        <p>
          ${t("This app is entirely client-side. Your token connects your browser")}
          ${t("directly to your Home Assistant via WebSocket, and that's the end of")}
          ${t("the road. No backend, no analytics, no telemetry, no cloud, no nothing.")}
        </p>
        <p>
          ${t("Then again, what if this whole paragraph is just a really convincing bluff? Fair point. The")} <a href="https://github.com/knowald/ha-hypertree" target="_blank" rel="noopener">${t("source code")}</a> ${t("is open - clone it, run it locally, verify it yourself. Words are cheap, code doesn't lie. Stay sharp out there.")}
        </p>
      </details>
      ` : ""}
    </form>
  `;

  const form = container.querySelector("#login-form") as HTMLFormElement;
  const urlInput = container.querySelector("#ha-url") as HTMLInputElement;
  const tokenInput = container.querySelector("#ha-token") as HTMLInputElement;
  urlInput.value = saved?.url ?? "";
  tokenInput.value = saved?.token ?? "";
  const protocolWarning = container.querySelector("#protocol-warning") as HTMLElement;

  function checkProtocolMismatch(): void {
    const inputUrl = urlInput.value.trim().toLowerCase();
    const pageIsHttps = location.protocol === "https:";
    const targetIsHttp = inputUrl.startsWith("http://");

    if (pageIsHttps && targetIsHttp) {
      const httpPage = location.href.replace(/^https:/, "http:");
      protocolWarning.innerHTML =
        t("Your browser blocks insecure WebSocket connections from HTTPS pages. ") +
        t("Try ") + `<a href="${httpPage}">${t("switching to HTTP")}</a>` +
        t(" to connect to a local HA instance. ") +
        t("If your browser redirects you back to HTTPS, manually replace ") +
        `<code>https</code> → <code>http</code> ${t("in your address bar.")}`;
      protocolWarning.hidden = false;
    } else {
      protocolWarning.hidden = true;
    }
  }

  urlInput.addEventListener("input", checkProtocolMismatch);
  checkProtocolMismatch();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    const token = tokenInput.value.trim();
    const creds = { url, token };
    saveCredentials(creds);
    onSubmit(creds);
  });
}

export function showLoginError(container: HTMLElement, message: string): void {
  const errorEl = container.querySelector("#login-error") as HTMLElement;
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
}

export function saveCredentials(creds: LoginCredentials): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
  } catch {
    // Ignore storage errors
  }
}

export function loadCredentials(): LoginCredentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // Ignore
  }
  return null;
}
