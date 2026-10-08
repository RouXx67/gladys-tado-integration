import { TADO, API_PATH, USER_AGENT } from './constants.js';

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

export class HttpError extends Error {
  constructor(message, { status, code, retryAfterMs }) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export class RateLimitedError extends HttpError {
  constructor(message, retryAfterMs) {
    super(message, { status: 429, code: 'RATE_LIMITED', retryAfterMs });
    this.name = 'RateLimitedError';
  }
}

export class AuthenticationError extends HttpError {
  constructor(message) {
    super(message, { status: 401, code: 'AUTHENTICATION_REQUIRED' });
    this.name = 'AuthenticationError';
  }
}

/**
 * Thin JSON HTTP client for the tado° classic (V2/V3) REST API.
 *
 * `getToken` is an async function returning the current access token
 * (refreshing it if needed). Every response is fed through the
 * RateLimitTracker so the scheduler can stay inside the daily budget.
 */
export class TadoClient {
  constructor({
    fetchImpl = globalThis.fetch,
    getToken,
    baseUrl = TADO.API_BASE_URL,
    backoff = defaultBackoff,
    tracker = null,
    logger,
    requestTimeoutMs = 15000,
    now = () => Date.now(),
  }) {
    if (!getToken) throw new Error('TadoClient requires a getToken function');
    this._fetch = fetchImpl;
    this._getToken = getToken;
    this._baseUrl = baseUrl;
    this._backoff = backoff;
    this._tracker = tracker;
    this._logger = logger;
    this._timeoutMs = requestTimeoutMs;
    this._now = now;
  }

  async request({ path, method = 'GET', query, body, auth = true }) {
    let url = `${this._baseUrl}${path}`;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += `?${qs}`;
    }

    let attempts = 0;
    let token;
    if (auth) token = await this._getToken();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempts += 1;
      const headers = { accept: 'application/json', 'user-agent': USER_AGENT };
      if (auth && token) headers.authorization = `Bearer ${token}`;
      let payload;
      if (body !== undefined) {
        payload = typeof body === 'string' ? body : JSON.stringify(body);
        if (!headers['content-type']) headers['content-type'] = 'application/json';
      }

      let res;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._timeoutMs);
        try {
          const response = await this._fetch(url, {
            method,
            headers,
            body: payload,
            signal: controller.signal,
          });
          const text = await response.text();
          let data;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (_) {
            data = text;
          }
          res = { status: response.status, headers: response.headers, data };
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
          throw new HttpError(`Request timed out after ${this._timeoutMs}ms`, { code: 'TIMEOUT' });
        }
        throw new HttpError(`Network error: ${err.message}`, { code: 'NETWORK' });
      }

      if (this._tracker) this._tracker.track(res.headers);

      if (res.status === 401 && auth && attempts <= 2 && token) {
        // Force a refresh (rotated/expired) and retry once.
        token = await this._getToken(true);
        if (token) continue;
        throw new AuthenticationError('tado° authentication failed');
      }

      if (res.status === 401) {
        throw new AuthenticationError('tado° authentication required');
      }

      if (res.status === 429) {
        const retryAfterMs = headerRetryAfterMs(res.headers, this._now());
        throw new RateLimitedError(`tado° rate limit reached (429)`, retryAfterMs);
      }

      if (res.status >= 500 && attempts <= MAX_RETRIES) {
        const delay = this._backoff(attempts);
        await sleep(delay);
        continue;
      }

      if (res.status >= 400) {
        throw new HttpError(
          `tado° API error (${res.status})`,
          { status: res.status, code: 'HTTP_ERROR' },
        );
      }

      if (this._logger && this._logger.child && res.status === 200 && (res.data && res.data.name === undefined)) {
        this._logger.child('client').debug(`Unexpected response from /me:`, res.data);
      }

      return { status: res.status, data: res.data };
    }
  }

  async getMe() {
    const res = await this.request({ path: API_PATH.me });
    if (this._logger && this._logger.child) {
      this._logger.child('client').debug('getMe response:', res.data);
    }
    return res.data !== undefined ? res.data : res;
  }

  async getHome(homeId) {
    const res = await this.request({ path: API_PATH.home(homeId) });
    return res.data !== undefined ? res.data : res;
  }

  async getZones(homeId) {
    const res = await this.request({ path: API_PATH.zones(homeId) });
    return res.data !== undefined ? res.data : res;
  }

  async getZoneStates(homeId) {
    const res = await this.request({ path: API_PATH.zoneStates(homeId) });
    return res.data !== undefined ? res.data : res;
  }

  async getZoneState(homeId, zoneId) {
    const res = await this.request({ path: API_PATH.zoneState(homeId, zoneId) });
    return res.data !== undefined ? res.data : res;
  }

  async getZoneCapabilities(homeId, zoneId) {
    const res = await this.request({ path: API_PATH.capabilities(homeId, zoneId) });
    return res.data !== undefined ? res.data : res;
  }

  async getZoneDevices(homeId, zoneId) {
    try {
      const res = await this.request({ path: API_PATH.devices(homeId, zoneId) });
      return res.data !== undefined ? res.data : res;
    } catch (err) {
      if (this._logger && this._logger.child) {
        this._logger.child('client').warn(`getZoneDevices failed for ${homeId}:${zoneId}: ${err.message}`);
      }
      return [];
    }
  }

  async getHomeDevices(homeId) {
    try {
      const res = await this.request({ path: API_PATH.homeDevices(homeId) });
      return res.data !== undefined ? res.data : res;
    } catch (err) {
      if (this._logger && this._logger.child) {
        this._logger.child('client').warn(`getHomeDevices failed for ${homeId}: ${err.message}`);
      }
      return [];
    }
  }

  async setOverlay(homeId, zoneId, overlay) {
    return this.request({
      path: API_PATH.overlay(homeId, zoneId),
      method: 'PUT',
      body: overlay,
    });
  }

  async clearOverlay(homeId, zoneId) {
    return this.request({ path: API_PATH.overlay(homeId, zoneId), method: 'DELETE' });
  }

  async get(path) {
    const res = await this.request({ path });
    return res.data !== undefined ? res.data : res;
  }
}

function defaultBackoff(attempt) {
  return BASE_RETRY_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250;
}

function headerRetryAfterMs(headers, now) {
  const h = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((v, k) => {
      h[k.toLowerCase()] = String(v);
    });
  } else if (headers) {
    for (const k of Object.keys(headers)) h[k.toLowerCase()] = String(headers[k]);
  }
  const retry = h['retry-after'];
  if (!retry) return null;
  const n = Number(retry);
  if (Number.isFinite(n)) return n * 1000;
  const date = Date.parse(retry);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}