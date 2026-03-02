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
      <p>Connect to your Home Assistant instance</p>
      <label>
        Home Assistant URL
        <input type="url" id="ha-url" placeholder="https://homeassistant.local:8123"
               value="${saved?.url ?? ""}" required />
      </label>
      <label>
        Long-Lived Access Token
        <input type="password" id="ha-token" placeholder="eyJhbGciOi..."
               value="${saved?.token ?? ""}" required />
      </label>
      <p id="protocol-warning" class="protocol-warning" hidden></p>
      <button type="submit">Connect</button>
      <p id="login-error" class="error" hidden></p>
      ${import.meta.env.VITE_HIDE_EXPLAINER !== "true" ? `
      <details class="token-explainer">
        <summary>Hold on, should I give you my token?</summary>
        <p>
          Darn it, no, but I almost got you.
        </p>
        <p>
          Just kidding - but seriously,
          never lose that reflex.
        </p>
        <p>
          This app is entirely client-side. Your token connects your browser
          directly to your Home Assistant via WebSocket, and that's the end of
          the road. No backend, no analytics, no telemetry, no cloud, no nothing.
        </p>
        <p>
          Then again, what if this whole paragraph is just a really convincing bluff? Fair point. The <a href="https://github.com/knowald/ha-hypertree" target="_blank" rel="noopener">source code</a> is open - clone it, run it locally, verify it yourself. Words are cheap, code doesn't lie. Stay sharp out there.
        </p>
      </details>
      ` : ""}
    </form>
  `;

  const form = container.querySelector("#login-form") as HTMLFormElement;
  const urlInput = container.querySelector("#ha-url") as HTMLInputElement;
  const protocolWarning = container.querySelector("#protocol-warning") as HTMLElement;

  function checkProtocolMismatch(): void {
    const inputUrl = urlInput.value.trim().toLowerCase();
    const pageIsHttps = location.protocol === "https:";
    const targetIsHttp = inputUrl.startsWith("http://");

    if (pageIsHttps && targetIsHttp) {
      const httpPage = location.href.replace(/^https:/, "http:");
      protocolWarning.innerHTML =
        `Your browser blocks insecure WebSocket connections from HTTPS pages. ` +
        `Try <a href="${httpPage}">switching to HTTP</a> to connect to a local HA instance. ` +
        `If your browser redirects you back to HTTPS, manually replace ` +
        `<code>https</code> with <code>http</code> in your address bar.`;
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
    const token = (container.querySelector("#ha-token") as HTMLInputElement).value.trim();
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

function saveCredentials(creds: LoginCredentials): void {
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
