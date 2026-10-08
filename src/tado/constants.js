// tado° API constants.
//
// Constantly verified against the current public tado° documentation and the
// widely used open-source clients (PyTado, the Home Assistant integration):
//
//  - Authentication is now the OAuth2 Device Code flow (RFC 8628). The legacy
//    username/password grant was removed by tado° in March 2025.
//  - Classic (V2/V3) homes are reached on `https://my.tado.com/api/v2/`.
//  - tado° X ("LINE_X") homes use a *different* API on `https://hops.tado.com`
//    (Rooms instead of Zones, `POST /rooms/{id}/manualControl`, ...). The
//    classic API does **not** fully support X, exactly like the Home Assistant
//    integration which requires the Matter integration for X devices.
//
// This integration targets the classic V2/V3 generation only and clearly
// reports LINE_X homes as unsupported (see README/docs).
export const TADO = {
  OAUTH_BASE_URL: 'https://login.tado.com',
  API_BASE_URL: 'https://my.tado.com/api/v2',
  HOPs_API_BASE_URL: 'https://hops.tado.com',

  // Public tado° mobile client id used by the device flow. It is published in
  // tado°'s own support article and in the reference clients.
  CLIENT_ID: '1bb50063-6b0c-4d11-bd99-387f4a91cc46',

  DEVICE_GRANT: 'urn:ietf:params:oauth:grant-type:device_code',
  SCOPE: 'offline_access',

  // Access tokens last ~10 minutes (3600 s); refresh tokens are valid up to
  // 30 days and rotate on every refresh.
  ACCESS_TOKEN_LIFETIME_SECONDS: 3600,
  PROACTIVE_REFRESH_RATIO: 0.8,
};

export const OAUTH_ENDPOINTS = {
  deviceAuthorize: '/oauth2/device_authorize',
  token: '/oauth2/token',
};

export const API_PATH = {
  me: '/me',
  home: (homeId) => `/homes/${homeId}`,
  zones: (homeId) => `/homes/${homeId}/zones`,
  zoneStates: (homeId) => `/homes/${homeId}/zoneStates`,
  zoneState: (homeId, zoneId) => `/homes/${homeId}/zones/${zoneId}/state`,
  capabilities: (homeId, zoneId) => `/homes/${homeId}/zones/${zoneId}/capabilities`,
  overlay: (homeId, zoneId) => `/homes/${homeId}/zones/${zoneId}/overlay`,
  devices: (homeId, zoneId) => `/homes/${homeId}/zones/${zoneId}/devices`,
  homeDevices: (homeId) => `/homes/${homeId}/devices`,
};

// tado° `generation` values returned by GET /homes/{id}.
export const GENERATION = {
  V2: 'V2',
  V3: 'V3',
  LINE_X: 'LINE_X',
};

export const ZONE_TYPES = {
  HEATING: 'HEATING',
  AIR_CONDITIONING: 'AIR_CONDITIONING',
  HOT_WATER: 'HOT_WATER',
};

// Overlay `termination` values accepted by the overlay PUT endpoint.
export const TERMINATION = {
  MANUAL: 'MANUAL',
  TIMER: 'TIMER',
  NEXT_TIME_BLOCK: 'NEXT_TIME_BLOCK',
};

// tado° rate limiting (official help article, January 2026):
//  - 100 requests/day on free accounts (no Auto-Assist / AI-Assist),
//  - 20,000 requests/day for subscribers,
//  - reset at ~12:00 Europe/Berlin.
// The remaining budget is advertised in the `ratelimit` / `ratelimit-policy`
// response headers.
export const RATE_LIMIT = {
  FREE_QUOTA: 100,
  SUBSCRIBED_QUOTA: 20000,
  RESET_MS: 24 * 60 * 60 * 1000,
};

// Default polling intervals (minutes) - conservative to respect the budget.
export const POLLING_DEFAULTS = {
  ACTIVE_MIN: 15,
  IDLE_MIN: 60,
};

export const USER_AGENT = 'gladys-tado-integration/1.0.0';