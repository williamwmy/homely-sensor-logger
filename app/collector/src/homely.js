import { log } from './logger.js';

// Klient for Homelys udokumenterte beta-API. Holder access-tokenet friskt med en
// proaktiv refresh-timer, slik at currentToken() alltid kan svare synkront
// (websocket-reconnect trenger tokenet uten å kunne vente).
export class HomelyClient {
  #apiBase;
  #username;
  #password;
  #accessToken = null;
  #refreshToken = null;
  #expiresAt = 0;
  #refreshTimer = null;
  #refreshing = null;

  constructor({ apiBase, username, password }) {
    this.#apiBase = apiBase;
    this.#username = username;
    this.#password = password;
  }

  async start() {
    await this.#login();
  }

  currentToken() {
    return this.#accessToken;
  }

  async #login() {
    const res = await fetch(`${this.#apiBase}/homely/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.#username, password: this.#password }),
    });
    if (!res.ok) {
      throw new Error(`Homely-innlogging feilet: HTTP ${res.status}`);
    }
    this.#setTokens(await res.json());
    log.info('logget inn mot Homely-API');
  }

  async #refresh() {
    try {
      const res = await fetch(`${this.#apiBase}/homely/oauth/refresh-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.#refreshToken }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      this.#setTokens(await res.json());
      log.debug('access-token fornyet');
    } catch (err) {
      log.warn('token-refresh feilet, logger inn på nytt', { error: String(err) });
      await this.#login();
    }
  }

  // Fornyer tokenet, og gir aldri opp: uten gyldig token er collectoren død.
  async #refreshWithRetry() {
    let delayMs = 30_000;
    for (;;) {
      try {
        await this.#refresh();
        return;
      } catch (err) {
        log.error('kunne ikke fornye token, prøver igjen', {
          error: String(err),
          retryInSeconds: delayMs / 1000,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 300_000);
      }
    }
  }

  #setTokens(body) {
    this.#accessToken = body.access_token;
    this.#refreshToken = body.refresh_token;
    this.#expiresAt = Date.now() + body.expires_in * 1000;

    clearTimeout(this.#refreshTimer);
    const delayMs = Math.max(30, body.expires_in * 0.8) * 1000;
    this.#refreshTimer = setTimeout(() => {
      this.#ensureFreshToken(true).catch(() => {});
    }, delayMs);
  }

  // force=true hopper over utløpssjekken (brukes av timeren og ved 401).
  #ensureFreshToken(force = false) {
    if (this.#refreshing) return this.#refreshing;
    if (!force && Date.now() < this.#expiresAt - 60_000) return Promise.resolve();
    this.#refreshing = this.#refreshWithRetry().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #get(path) {
    await this.#ensureFreshToken();
    let res = await fetch(`${this.#apiBase}${path}`, {
      headers: { authorization: `Bearer ${this.#accessToken}` },
    });
    if (res.status === 401) {
      await this.#ensureFreshToken(true);
      res = await fetch(`${this.#apiBase}${path}`, {
        headers: { authorization: `Bearer ${this.#accessToken}` },
      });
    }
    if (!res.ok) {
      const err = new Error(`GET ${path} feilet: HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  locations() {
    return this.#get('/homely/locations');
  }

  home(locationId) {
    return this.#get(`/homely/home/${locationId}`);
  }
}
