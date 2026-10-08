import { TADO, OAUTH_ENDPOINTS } from './constants.js';
import { AUTH_HEADERS } from './http.js';

/**
 * Handles the tado° authentication, which today is the OAuth2 *Device Code*
 * flow (RFC 8628). The legacy username/password grant was removed by tado° in
 * March 2025 - there is deliberately no password-based path here.
 *
 * The flow maps cleanly onto Gladys' `account_link` config field: Gladys shows
 * a "Connect" button, the integration starts the device flow and returns the
 * verification URL, and polls the token endpoint until the user approves it in
 * their browser or in the tado° app.
 *
 * Only a refresh token is persisted (through the Gladys config storage, never
 * in logs or the repo). The access token lives in memory and is refreshed
 * proactively. Refresh tokens are valid ~30 days and rotate on each refresh.
 */
export class TadoTokenManager {
  constructor({ http, persist, logger, now = () => Date.now() }) {
    this._http = http;
    this._persist = persist; // async (refreshToken) => Promise
    this._logger = logger;
    this._now = now;

    this._accessToken = null;
    this._expiresAtMs = 0;
    this._refreshToken = null;

    this._deviceCode = null;
    this._pollTimer = null;
    this._pollIntervalMs = 5000;
    this._pollDeadlineMs = 0;

    this._refreshing = null;
  }

  hasSession() {
    return this._refreshToken !== null || this._accessToken !== null;
  }

  /**
   * Start the device flow. Returns the verification URI to display and the
   * user code (for display/logging). Begins background polling for approval.
   */
  async start() {
    const body = new URLSearchParams({
      client_id: TADO.CLIENT_ID,
      scope: TADO.SCOPE,
    });
    const res = await this._http.request({
      url: `${TADO.OAUTH_BASE_URL}${OAUTH_ENDPOINTS.deviceAuthorize}`,
      method: 'POST',
      headers: AUTH_HEADERS,
      body: body.toString(),
      auth: false,
      doNotThrow: true,
    });

    if (res.status !== 200) {
      const detail = safeBody(res);
      throw new Error(
        `Could not start the tado° login (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
      );
    }

    const data = res.data;
    this._deviceCode = data.device_code;
    // The CLI supplies verification_uri; the full URL pre-fills the user code.
    const verifyUri = data.verification_uri_complete || data.verification_uri;
    this._pollIntervalMs = Math.max(Number(data.interval) || 5, 5) * 1000;
    this._pollDeadlineMs =
      this._now() + (Number(data.expires_in) || 300) * 1000;

    this._startPolling();

    return {
      verificationUri: verifyUri,
      userCode: data.user_code,
      expiresIn: Number(data.expires_in || 300),
    };
  }

  _startPolling() {
    this._clearPolling();
    this._pollTimer = setInterval(() => {
      this._pollOnce().catch((err) => {
        this._logger.child('auth').debug('device flow poll error', err.message);
      });
    }, this._pollIntervalMs);
  }

  _clearPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _pollOnce() {
    if (!this._deviceCode) return;
    if (this._now() > this._pollDeadlineMs) {
      this._logger.child('auth').warn('device flow expired, cancelling');
      this._clearPolling();
      this._deviceCode = null;
      return;
    }

    try {
      const body = new URLSearchParams({
        client_id: TADO.CLIENT_ID,
        device_code: this._deviceCode,
        grant_type: TADO.DEVICE_GRANT,
      });
      const res = await this._http.request({
        url: `${TADO.OAUTH_BASE_URL}${OAUTH_ENDPOINTS.token}`,
        method: 'POST',
        headers: AUTH_HEADERS,
        body: body.toString(),
        auth: false,
        doNotThrow: true,
      });

      if (res.status === 200) {
        this._clearPolling();
        this._deviceCode = null;
        await this._applyTokenResponse(res.data);
        this._logger.child('auth').info('device flow approved');
        this.onAuthenticated && this.onAuthenticated();
        return;
      }

      // authorization_pending / slow_down -> keep polling, extend interval on
      // slow_down as required by RFC 8628.
      const code = res.data && res.data.error;
      if (code === 'slow_down') {
        this._pollIntervalMs = Math.min(this._pollIntervalMs + 5000, 60000);
        this._clearPolling();
        this._startPolling();
        return;
      }
      if (code === 'authorization_pending') return;
      // expired_token / access_denied / invalid_grant -> terminal.
      this._clearPolling();
      this._deviceCode = null;
      throw new Error(`tado° device flow refused: ${code || `HTTP ${res.status}`}`);
    } catch (err) {
      this._clearPolling();
      this._deviceCode = null;
      throw err;
    }
  }

  async _applyTokenResponse(data) {
    this._accessToken = data.access_token;
    this._expiresAtMs = this._now() + Number(data.expires_in || TADO.ACCESS_TOKEN_LIFETIME_SECONDS) * 1000;
    if (data.refresh_token) {
      this._refreshToken = data.refresh_token;
      await this._persist(data.refresh_token);
    }
    this._onChanged && this._onChanged();
  }

  /**
   * Returns a valid access token, refreshing first if it is expired or close
   * to expiry. Never throws when we can retry a single refresh.
   */
  async getValidAccessToken(force = false) {
    if (
      !force &&
      this._accessToken &&
      this._now() <
        this._expiresAtMs - TADO.ACCESS_TOKEN_LIFETIME_SECONDS * 1000 * (1 - TADO.PROACTIVE_REFRESH_RATIO)
    ) {
      return this._accessToken;
    }
    if (!this._refreshToken) {
      throw new Error('tado°: no session, please connect your account');
    }
    if (this._refreshing && !force) return this._refreshing;
    this._refreshing = this._refresh(force).finally(() => {
      this._refreshing = null;
    });
    return this._refreshing;
  }

  async _refresh(force) {
    const body = new URLSearchParams({
      client_id: TADO.CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: this._refreshToken,
      scope: TADO.SCOPE,
    });
    const res = await this._http.request({
      url: `${TADO.OAUTH_BASE_URL}${OAUTH_ENDPOINTS.token}`,
      method: 'POST',
      headers: AUTH_HEADERS,
      body: body.toString(),
      auth: false,
      doNotThrow: true,
    });

    if (res.status !== 200) {
      // terminal: refresh token invalid/expired -> drop session.
      const detail = res.data && res.data.error;
      this._logger.child('auth').warn(
        `refresh failed (${res.status}${detail ? ` ${detail}` : ''}) - clearing session`,
      );
      this._accessToken = null;
      this._refreshToken = null;
      throw new Error('tado° session expired, please reconnect your account');
    }

    await this._applyTokenResponse(res.data);
    this._logger.child('auth').debug('access token refreshed');
    return this._accessToken;
  }

  /**
   * Restore a persisted refresh token at startup/on-reconnect.
   */
  async restore(refreshToken) {
    if (!refreshToken) return;
    this._refreshToken = refreshToken;
    try {
      await this.getValidAccessToken();
      return true;
    } catch (err) {
      this._logger.child('auth').warn('restored session invalid', err.message);
      return false;
    }
  }

  disconnect() {
    this._clearPolling();
  }

  setAuthenticatedCallbacks({ onAuthenticated, onChanged }) {
    this.onAuthenticated = onAuthenticated;
    this._onChanged = onChanged;
  }
}

function safeBody(res) {
  try {
    if (typeof res.data === 'string') return res.data.slice(0, 300);
    if (res.data && typeof res.data === 'object') {
      return res.data.error_description || res.data.message;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}
