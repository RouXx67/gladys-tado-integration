import {
  GladysIntegration,
  logger,
} from '@gladysassistant/integration-sdk';

import { TadoClient } from './tado/client.js';
import { createRawHttp } from './tado/http.js';
import { RateLimitTracker } from './tado/ratelimit.js';
import { TadoTokenManager } from './tado/auth.js';
import { TadoController } from './gladys/controller.js';
import { createCommandHandler } from './gladys/commands.js';

const CONFIG_KEY_REFRESH_TOKEN = 'tado_refresh_token';

// The SDK reads GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN and
// GLADYS_INTEGRATION_SELECTOR from the container environment injected by
// Gladys. The tado° account address is NOT hardcoded anywhere.
const gladys = new GladysIntegration();

const log = logger;

// ---- shared infrastructure -------------------------------------------------
const tracker = new RateLimitTracker();
const rawHttp = createRawHttp({ tracker });

const tokenManager = new TadoTokenManager({
  http: rawHttp,
  logger: log,
  persist: async (refreshToken) => {
    // Persisted through Gladys' internal config storage (the key is NOT part
    // of the manifest config_schema, so it never reaches the frontend).
    await gladys.setConfig({ [CONFIG_KEY_REFRESH_TOKEN]: refreshToken });
  },
});

const client = new TadoClient({
  getToken: (force = false) => tokenManager.getValidAccessToken(force),
  tracker,
  logger: log,
});

const controller = new TadoController({ gladys, client, tokenManager, logger: log });
const commands = createCommandHandler({
  client,
  logger: log,
  getConfig: () => controller.getConfig(),
  getLatest: (key) => controller.getLatest(key),
  getCapabilities: (key) => controller.getCapabilities(key),
  refreshNow: (homeId) => controller.pollHomeNow(homeId),
});

// ---- connection status + auth callbacks -------------------------------------
const markAuthenticated = async () => {
  gladys.setConnectionStatus(true);
  await controller.bootstrap();
};
tokenManager.setAuthenticatedCallbacks({
  onAuthenticated: markAuthenticated,
  onChanged: () => {},
});

// ---- SDK handlers -----------------------------------------------------------
gladys.onScanRequest(async () => {
  log.child('discovery').info('scan requested');
  if (!tokenManager.hasSession()) {
    const msg = 'tado° account not linked. Connect it in the Configuration tab.';
    log.child('discovery').warn(msg);
    throw new Error(msg);
  }
  try {
    await controller.discover();
  } catch (err) {
    log.child('discovery').error(`scan failed: ${err.message}`);
    if (err.stack) log.child('discovery').debug(err.stack);
    throw err;
  }
});

gladys.onSetValue(commands.handleSetValue);

gladys.onConfigUpdated(async (config) => {
  controller.applyConfig(config);
});

gladys.onOAuthAuthorizeUrl(async () => {
  const { verificationUri } = await tokenManager.start();
  return verificationUri;
});

// `account_link` never redirects back, so onOAuthCallback is never called.
gladys.onOAuthCallback(async () => {
  throw new Error('Unexpected OAuth callback for an account_link flow');
});

gladys.handleShutdown(async () => {
  await controller.handleShutdown();
});

// ---- start -----------------------------------------------------------------
await gladys.connect();
controller.applyConfig(gladys.config);

// Restore a previously linked session (persisted refresh token).
const restored = await tokenManager.restore(gladys.config[CONFIG_KEY_REFRESH_TOKEN]);
if (restored) {
  await controller.bootstrap();
} else {
  gladys.setConnectionStatus(false, {
    en: 'tado° account not linked. Go to Configuration and connect it.',
    fr: 'Compte tado° non lié. Rendez-vous dans Configuration pour le connecter.',
  });
}

controller.start();
log.info('gladys-tado-integration started');