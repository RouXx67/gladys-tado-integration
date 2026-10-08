import {
  RateLimitedError,
  AuthenticationError,
  HttpError,
} from '../tado/client.js';
import { GENERATION, ZONE_TYPES, RATE_LIMIT } from '../tado/constants.js';
import { normalizeZone } from '../tado/state.js';
import { buildGladysDevice, zoneToValues } from './mapper.js';

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
    this._deviceIndex = new Map();
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
    const meRes = await this.client.getMe();
    const me = meRes && meRes.data ? meRes.data : meRes;
    this.logger.child('discovery').info(
      `account "${me && me.name || 'unknown'}" has ${(me && me.homes || []).length} home(s)`,
    );
    this.logger.child('discovery').debug('Full "me" object from Tado:', me);

    const homes = await Promise.all(
      (me && me.homes || []).map(async (h) => {
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
    this._deviceIndex = new Map();

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
      this.logger.child('discovery').debug(`Found ${zones.length} zones for home "${home.name}"`);
      for (const zone of zones || []) {
        if (zone.type === ZONE_TYPES.HOT_WATER) {
          this.logger.child('discovery').debug(
            `zone "${zone.name}" (ID: ${zone.id}) is a hot-water zone, not exposed in this version`,
          );
          continue;
        }
        let caps = {};
        try {
          caps = await this.client.getZoneCapabilities(home.id, zone.id);
        } catch (err) {
          this.logger.child('discovery').error(`error fetching capabilities for zone "${zone.name}" (ID: ${zone.id}): ${err.message}`);
        }
        
        let zoneDevices = [];
        try {
          zoneDevices = await this.client.getZoneDevices(home.id, zone.id);
          this.logger.child('discovery').debug(`Zone devices for "${zone.name}" (ID: ${zone.id}):`, zoneDevices);
        } catch (err) {
          this.logger.child('discovery').debug(`no zone devices info: ${err.message}`);
        }
        
        this.logger.child('discovery').debug(`Zone: ${zone.name} (ID: ${zone.id})`, { capabilities: caps });
        
        const key = `${home.id}:${zone.id}`;
        const idType = zone.type === ZONE_TYPES.AIR_CONDITIONING ? 'ac' : 'thermostat';
        const ids = this.gladys.externalIds(idType, `${home.id}:${zone.id}`);
        
        if (ids.device === undefined) {
          this.logger.child('discovery').error(`Failed to generate external IDs for zone ${zone.name}`);
          continue;
        }

        this._zoneIndex.set(key, {
          homeId: home.id,
          zone: { ...zone, homeId: home.id },
          ids,
        });
        this._rawCapabilities.set(key, caps);

        devices.push(
          buildGladysDevice({
            ids,
            zone: { ...zone, homeId: home.id },
            capabilities: caps,
            devices: zoneDevices,
          }),
        );

        for (const d of (zoneDevices || [])) {
          if (d && d.id) {
            this._deviceIndex.set(String(d.id), {
              homeId: home.id,
              zoneId: zone.id,
            });
          }
        }
      }
    }

    this.logger.child('discovery').info(`built ${devices.length} device(s)`);
    if (devices.length > 0) {
      try {
        await this.gladys.publishDiscoveredDevices(devices);
        await this.gladys.publishTransports(
          devices.map((d) => ({ external_id: d.external_id, transport: 'cloud' })),
        );
      } catch (err) {
        this.logger.child('discovery').error(`failed to publish discovered devices: ${err.message}`);
        throw err;
      }
    } else {
      this.logger.child('discovery').warn('No devices found to publish.');
    }

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
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
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
        this.logger.child('poll').warn(`zone ${entry.zone.id} state: ${err.message}`);
        continue;
      }

      let zoneDevices = [];
      try {
        zoneDevices = await this.client.getZoneDevices(entry.homeId, entry.zone.id);
      } catch (err) {
        this.logger.child('poll').debug(`no zone devices: ${err.message}`);
      }

      const key = `${entry.homeId}:${entry.zone.id}`;
      const normalized = normalizeZone({ ...entry.zone, homeId: entry.homeId }, zoneState, zoneDevices);
      this._latest.set(key, normalized);

      const values = zoneToValues(normalized);
      for (const [featureKey, value] of Object.entries(values)) {
        try {
          const externalId = entry.ids.feature(featureKey);
          if (this._lastValues.get(externalId) !== value) {
            this._lastValues.set(externalId, value);
            states.push({ device_feature_external_id: externalId, state: value });
          }
        } catch (e) {
          // skip if feature not defined
        }
      }
      if (normalized.running) anyRunning = true;
    }

    if (states.length > 0) {
      const MAX_STATES_PER_REQUEST = 200;
      for (let i = 0; i < states.length; i += MAX_STATES_PER_REQUEST) {
        await this.gladys.publishStates(states.slice(i, i + MAX_STATES_PER_REQUEST));
      }
    }

    return { anyRunning };
  }

  async pollHomeNow(homeId) {
    await this.pollOnce(homeId);
  }

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
