import {
  RateLimitedError,
  AuthenticationError,
  HttpError,
} from '../tado/client.js';
import { GENERATION, ZONE_TYPES, RATE_LIMIT } from '../tado/constants.js';
import { normalizeZone } from '../tado/state.js';
import { buildGladysDevice, zoneToValues } from './mapper.js';

const MAX_STATES_PER_REQUEST = 100;

/**
 * Owns the integration lifecycle against Gladys: device discovery, the
 * adaptive polling loop (respecting tado°'s daily rate limit), state
 * publishing and connection-status reporting.
 */
export class TadoController {
  constructor({ gladys, client, tokenManager, logger }) {
    this.gladys = gladys;
    this.client = client;
    this.tokenManager = tokenManager;
    this.logger = logger;
    this.tracker = this.client._tracker;

    this.config = {};
    this._homes = [];
    this._zoneIndex = new Map(); // "homeId:zoneId" -> { homeId, zone, ids, type }
    this._rawCapabilities = new Map(); // "homeId:zoneId" -> raw capabilities payload
    this._lastValues = new Map(); // external_id -> last published value
    this._latest = new Map(); // "homeId:zoneId" -> last normalized zone
    this._callsPerCycle = 0;

    this._timer = null;
    this._stopped = true;
    this._polling = false;
  }

  // ---- configuration -----------------------------------------------------

  applyConfig(config = {}) {
    this.config = config || {};
    this.logger.child('controller').debug('config applied', {
      active: this.config.polling_interval_active_min,
      idle: this.config.polling_interval_idle_min,
      termination: this.config.overlay_termination,
    });
  }

  getConfig() {
    return this.config;
  }

  getLatest(key) {
    return this._latest.get(key);
  }

  getCapabilities(key) {
    const raw = this._rawCapabilities.get(key);
    if (!raw || !raw.temperatures || !raw.temperatures.celsius) return null;
    return {
      min: raw.temperatures.celsius.min,
      max: raw.temperatures.celsius.max,
    };
  }

  hasSession() {
    return this.tokenManager.hasSession();
  }

  // ---- lifecycle ---------------------------------------------------------

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._schedule(0);
  }

  stop() {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async handleShutdown() {
    this.stop();
    this.tokenManager.disconnect();
  }

  // ---- discovery ---------------------------------------------------------

  async discover() {
    const me = await this.client.getMe();
    this.logger.child('discovery').info(
      `account "${me.name}" has ${(me.homes || []).length} home(s)`,
    );

    const homes = await Promise.all(
      (me.homes || []).map(async (h) => {
        let home;
        try {
          home = await this.client.getHome(h.id);
        } catch (err) {
          this.logger.child('discovery').warn(`skip home ${h.id}: ${err.message}`);
          return null;
        }
        this.logger.child('discovery').info(
          `home "${home.name || h.name}" id=${h.id} generation=${home.generation || 'unknown'}`,
        );
        return {
          id: h.id,
          name: home.name || h.name,
          generation: home.generation || GENERATION.V3,
        };
      }),
    );
    this._homes = homes.filter(Boolean);
    this._zoneIndex.clear();
    this._rawCapabilities.clear();

    const devices = [];
    for (const home of this._homes) {
      if (home.generation === GENERATION.LINE_X) {
        this.logger.child('discovery').warn(
          `home "${home.name}" is tado° X (LINE_X) - not supported by the classic API (my.tado.com), skipped`,
        );
        continue;
      }
      let zones;
      try {
        zones = await this.client.getZones(home.id);
      } catch (err) {
        this.logger.child('discovery').error(`cannot list zones of ${home.name}: ${err.message}`);
        continue;
      }
      for (const zone of zones || []) {
        if (zone.type === ZONE_TYPES.HOT_WATER) {
          this.logger.child('discovery').debug(
            `zone "${zone.name}" is a hot-water zone, not exposed in this version`,
          );
          continue;
        }
        let caps = {};
        try {
          caps = await this.client.getZoneCapabilities(home.id, zone.id);
        } catch (err) {
          this.logger.child('discovery').debug(
            `no capabilities for zone "${zone.name}": ${err.message}`,
          );
        }
        const key = `${home.id}:${zone.id}`;
        this._rawCapabilities.set(key, caps);
        const idType = zone.type === ZONE_TYPES.AIR_CONDITIONING ? 'ac' : 'thermostat';
        const ids = this.gladys.externalIds(idType, `${home.id}:${zone.id}`);
        this._zoneIndex.set(key, { homeId: home.id, zone, ids, type: zone.type });
        devices.push(
          buildGladysDevice({
            ids,
            zone: { ...zone, homeId: home.id },
            capabilities: caps,
          }),
        );
      }
    }

    this.logger.child('discovery').info(`built ${devices.length} device(s)`);
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.logger.child('discovery').error(
        `publishDiscoveredDevices rejected (${devices.length} devices): ${err.message}`,
      );
      throw err;
    }
    await this.gladys.publishTransports(
      devices.map((d) => ({ external_id: d.external_id, transport: 'cloud' })),
    );

    this.logger.child('discovery').info(`discovered ${devices.length} device(s)`);

    // Populate states right after a scan so the dashboard is reactive without
    // waiting for the next poll cycle.
    if (this._zoneIndex.size > 0) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.logger.child('discovery').warn(`initial state fetch failed: ${err.message}`);
      }
    }
  }

  // ---- polling -----------------------------------------------------------

  _activeFloorMs() {
    const active = Number(this.config.polling_interval_active_min);
    return (Number.isFinite(active) ? active : 15) * 60 * 1000;
  }

  _idleFloorMs() {
    const idle = Number(this.config.polling_interval_idle_min);
    return (Number.isFinite(idle) ? idle : 60) * 60 * 1000;
  }

  _schedule(delayMs) {
    if (this._stopped) return;
    if (this._timer) clearTimeout(this._timer);
    const clamp = Math.max(0, Math.min(delayMs, RATE_LIMIT.RESET_MS));
    this._timer = setTimeout(() => {
      this._tick().catch((err) => {
        this.logger.child('poll').error('uncaught poll error', err.message);
      });
    }, clamp);
  }

  async _tick() {
    if (this._stopped) return;
    if (!this.hasSession()) {
      this.gladys.setConnectionStatus(false, {
        en: 'tado° account not linked.',
        fr: 'Compte tado° non lié.',
      });
      this._schedule(60 * 1000);
      return;
    }

    let anyRunning = false;
    let error = null;
    try {
      const result = await this.pollOnce();
      anyRunning = result.anyRunning;
      this.gladys.setConnectionStatus(true);
    } catch (err) {
      error = err;
      this._onPollError(err);
    }

    const floor = anyRunning && !error ? this._activeFloorMs() : this._idleFloorMs();
    let delay = this.tracker
      ? this.tracker.suggestInterval(Math.max(1, this._callsPerCycle), floor)
      : floor;

    if (error instanceof RateLimitedError) {
      delay = Math.max(delay, error.retryAfterMs || 60 * 60 * 1000);
    } else if (error instanceof AuthenticationError) {
      delay = Math.max(delay, 30 * 60 * 1000);
    } else if (error instanceof HttpError) {
      delay = Math.max(delay, 10 * 60 * 1000);
    }

    this._schedule(delay);
  }

  _onPollError(err) {
    if (err instanceof RateLimitedError) {
      this.logger.child('poll').warn('rate limited, backing off');
      this.gladys.setConnectionStatus(false, {
        en: 'tado° rate limit reached. Backing off.',
        fr: 'Limite de requêtes tado° atteinte. Pause.',
      });
    } else if (err instanceof AuthenticationError) {
      this.logger.child('poll').warn('authentication error');
      this.gladys.setConnectionStatus(false, {
        en: 'tado° authentication failed. Please re-link your account.',
        fr: 'Échec d’authentification tado°. Re-liez votre compte.',
      });
    } else {
      this.logger.child('poll').warn(`poll failed: ${err.message}`);
      this.gladys.setConnectionStatus(false, {
        en: 'tado° unreachable. Retrying…',
        fr: 'tado° injoignable. Nouvel essai…',
      });
    }
  }

  /**
   * Poll all supported homes (or a single home when `filterHomeId` is given),
   * publish only the changed states, and report whether anything is running.
   */
  async pollOnce(filterHomeId) {
    let anyRunning = false;
    const states = [];
    this._callsPerCycle = 0;

    for (const entry of this._zoneIndex.values()) {
      if (filterHomeId != null && Number(entry.homeId) !== Number(filterHomeId)) continue;
      if (!entry || !entry.ids) continue;

      this._callsPerCycle += 1;
      let zoneState;
      try {
        zoneState = await this.client.getZoneState(entry.homeId, entry.zone.id);
      } catch (err) {
        if (err instanceof RateLimitedError || err instanceof AuthenticationError) throw err;
        this.logger.child('poll').warn(
          `zone ${entry.zone.id} state: ${err.message}`,
        );
        continue;
      }

      const key = `${entry.homeId}:${entry.zone.id}`;
      const normalized = normalizeZone({ ...entry.zone, homeId: entry.homeId }, zoneState);
      this._latest.set(key, normalized);

      const values = zoneToValues(normalized);
      for (const [featureKey, value] of Object.entries(values)) {
        const externalId = entry.ids.feature(featureKey);
        if (this._lastValues.get(externalId) !== value) {
          this._lastValues.set(externalId, value);
          states.push({ device_feature_external_id: externalId, state: value });
        }
      }
      if (normalized.running) anyRunning = true;
    }

    if (states.length > 0) {
      for (let i = 0; i < states.length; i += MAX_STATES_PER_REQUEST) {
        await this.gladys.publishStates(states.slice(i, i + MAX_STATES_PER_REQUEST));
      }
    }

    return { anyRunning };
  }

  async pollHomeNow(homeId) {
    await this.pollOnce(homeId);
  }

  /**
   * Restore the persisted session, prime the latest values and start polling.
   */
  async bootstrap() {
    if (!this.hasSession()) {
      this.gladys.setConnectionStatus(false, {
        en: 'tado° account not linked.',
        fr: 'Compte tado° non lié.',
      });
      return;
    }
    try {
      // Load the latest state once so the dashboard is filled quickly.
      await this.pollOnce();
      this.gladys.setConnectionStatus(true);
    } catch (err) {
      this._onPollError(err);
    }
  }
}