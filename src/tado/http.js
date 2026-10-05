import { USER_AGENT } from './constants.js';

/**
 * Minimal raw HTTP helper for the OAuth endpoints (which live on
 * login.tado.com, not the data API). It returns { status, headers, data } and
 * feeds the response headers through the shared RateLimitTracker.
 */
export function createRawHttp({ fetchImpl = globalThis.fetch, tracker = null, timeoutMs = 15000 } = {}) {
  return {
    async request({ method = 'GET', url, headers = {}, body }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
        const text = await res.text();
        let data;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (_) {
          data = text;
        }
        if (tracker) tracker.track(res.headers);
        return { status: res.status, headers: res.headers, data };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const AUTH_HEADERS = {
  'content-type': 'application/x-www-form-urlencoded',
  accept: 'application/json',
  'user-agent': USER_AGENT,
};