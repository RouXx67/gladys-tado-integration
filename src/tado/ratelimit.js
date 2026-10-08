import { RATE_LIMIT } from './constants.js';

/**
 * Parses and tracks the rate-limit budget that tado° advertises in its
 * response headers so the polling loop can stay inside the daily quota.
 *
 * Header format (lower-cased by the client):
 *   ratelimit:        "perday";r=<remaining>[;t=<seconds-to-reset>]
 *   ratelimit-policy: "perday";q=<quota>;w=86400
 *
 * The remaining budget is authoritative when present; otherwise the quota is
 * inferred from the tier (free / subscribed) for scheduling purposes.
 */
export class RateLimitTracker {
  constructor({ now = () => Date.now(), options = {} } = {}) {
    this._now = now;
    this._quota = options.quota ?? null;
    this._remaining = null;
    this._resetAt = null;
    this._lastSeenAt = null;
  }

  get quota() {
    return this._quota;
  }

  get remaining() {
    return this._remaining;
  }

  get isFreeTier() {
    return this._quota !== null && this._quota <= RATE_LIMIT.FREE_QUOTA;
  }

  _neverSeen() {
    return this._remaining === null;
  }

  /**
   * Feed a headers object (any casing). Returns the parsed info for tests.
   */
  track(headers) {
    const h = lowerCaseHeaders(headers);
    const policy = h['ratelimit-policy'] || null;
    const limit = h['ratelimit'] || h['ratelimit-limit'] || null;

    let quota = this._quota;
    if (policy) {
      const parsed = parseQuotedParams(policy);
      if (parsed.q != null) quota = Number(parsed.q);
      if (parsed.q == null && parsed.quota != null) quota = Number(parsed.quota);
      const w = parsed.w ? Number(parsed.w) : null;
      if (w) this._resetAt = this._now() + w * 1000;
    }

    if (limit) {
      const parsed = parseQuotedParams(limit);
      if (parsed.r != null) {
        this._remaining = Number(parsed.r);
        this._lastSeenAt = this._now();
      }
      if (parsed.t != null) {
        this._resetAt = this._now() + Number(parsed.t) * 1000;
      }
    }

    this._quota = quota;
    return this.snapshot();
  }

  /**
   * Days since the last header was seen (if the API stops sending the header
   * we fall back to the configured tier defaults).
   */
  staleDays() {
    if (this._lastSeenAt === null) return 0;
    return (this._now() - this._lastSeenAt) / RATE_LIMIT.RESET_MS;
  }

  /**
   * Whether we still consider the budget known (fresh enough to trust).
   */
  hasAuthority() {
    return !this._neverSeen() && this.staleDays() < 1.5;
  }

  /**
   * Suggest a minimum delay (ms) before the next poll cycle so the remaining
   * budget is spread over the rest of the reset window.
   *
   * `callsPerCycle` is the estimated number of API calls the next poll will
   * perform (zoneStates + one state call per zone). The returned value is at
   * least `floorIntervalMs` and at most one day.
   */
  suggestInterval(callsPerCycle, floorIntervalMs) {
    if (!this.hasAuthority()) return floorIntervalMs;
    const remaining = this._remaining;
    if (remaining <= 0) return RATE_LIMIT.RESET_MS;

    const windowMs =
      this._resetAt !== null
        ? Math.max(1, this._resetAt - this._now())
        : RATE_LIMIT.RESET_MS;

    // Leave a small safety margin (5%) for commands / re-discovery.
    const usable = Math.max(1, remaining - Math.ceil(remaining * 0.05));
    const intervalMs = (windowMs / usable) * Math.max(1, callsPerCycle);
    return clamp(intervalMs, floorIntervalMs, RATE_LIMIT.RESET_MS);
  }

  snapshot() {
    return {
      quota: this._quota,
      remaining: this._remaining,
      resetAt: this._resetAt,
      isFreeTier: this.isFreeTier,
      staleDays: this.staleDays(),
      authority: this.hasAuthority(),
    };
  }
}

function parseQuotedParams(value) {
  const out = {};
  const re = /([a-z_][a-z0-9_-]*)\s*=\s*(?:"([^"]*)"|(\d+))/gi;
  let m;
  while ((m = re.exec(value)) !== null) {
    out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

function lowerCaseHeaders(headers) {
  const out = {};
  if (!headers) return out;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  for (const key of Object.keys(headers)) {
    out[key.toLowerCase()] = String(headers[key]);
  }
  return out;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}