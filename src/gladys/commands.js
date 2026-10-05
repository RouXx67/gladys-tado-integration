import { ZONE_TYPES, TERMINATION } from '../tado/constants.js';
import {
  THERMOSTAT_MODES,
  AC_MODES,
  acModeToTado,
  tadoAcModeToType,
} from '../tado/state.js';

/**
 * Executes `onSetValue` commands coming from Gladys against the tado° API.
 *
 * Only commands the tado° API can actually execute are exposed (see the
 * discovery mapper): target temperature, mode (off / schedule / manual) and
 * AC power. Each maps to an overlay PUT or DELETE on the relevant zone.
 */
export function createCommandHandler({
  client,
  logger,
  getConfig,
  getLatest,
  getCapabilities,
  refreshNow,
}) {
  const lastSetpoints = new Map(); // "home:zone" -> last requested target (°C)
  const lastAcModes = new Map(); // "home:zone" -> last AC mode integer

  async function handleSetValue(device, feature, value) {
    const ctx = readParams(device);
    if (!ctx) {
      throw new Error(`Unknown device (external_id=${device.external_id})`);
    }
    const key = ctx.key;

    if (feature.type === 'target-temperature') {
      lastSetpoints.set(key, value);
      await setTargetTemperature(ctx, value, key);
    } else if (feature.type === 'mode') {
      await setMode(ctx, value, key);
    } else if (feature.category === 'air-conditioning' && feature.type === 'binary') {
      await setAcPower(ctx, value, key);
    } else {
      throw new Error(`Unsupported command (${feature.category}/${feature.type})`);
    }

    logger.child('commands').debug('command applied', {
      zone: ctx.zoneId,
      feature: feature.type,
      value,
    });

    await refreshNow(ctx.homeId);
  }

  async function setTargetTemperature(ctx, temperature, key) {
    const setpoint = clampTemperature(ctx, temperature);
    if (ctx.zoneType === ZONE_TYPES.AIR_CONDITIONING) {
      const acMode = lastAcModes.get(key) || AC_MODES.AUTO;
      const tadoMode = acModeToTado(acMode) || 'AUTO';
      await client.setOverlay(ctx.homeId, ctx.zoneId, {
        setting: {
          type: tadoAcModeToType(tadoMode),
          power: 'ON',
          mode: tadoMode,
          temperature: { celsius: setpoint },
        },
        termination: overlayTermination(getConfig()),
      });
    } else {
      await client.setOverlay(ctx.homeId, ctx.zoneId, {
        setting: {
          type: 'HEATING',
          power: 'ON',
          temperature: { celsius: setpoint },
        },
        termination: overlayTermination(getConfig()),
      });
    }
  }

  async function setMode(ctx, mode, key) {
    if (ctx.zoneType === ZONE_TYPES.AIR_CONDITIONING) {
      await setAcMode(ctx, mode, key);
      return;
    }

    switch (mode) {
      case THERMOSTAT_MODES.OFF: {
        await client.setOverlay(ctx.homeId, ctx.zoneId, {
          setting: { type: 'HEATING', power: 'OFF' },
          termination: overlayTermination(getConfig()),
        });
        break;
      }
      case THERMOSTAT_MODES.SCHEDULE: {
        await client.clearOverlay(ctx.homeId, ctx.zoneId);
        break;
      }
      case THERMOSTAT_MODES.MANUAL: {
        const setpoint = lastSetpoints.get(key) ?? fallbackSetpoint(ctx);
        if (setpoint == null) {
          throw new Error('Manual mode: no target temperature available yet');
        }
        await client.setOverlay(ctx.homeId, ctx.zoneId, {
          setting: {
            type: 'HEATING',
            power: 'ON',
            temperature: { celsius: clampTemperature(ctx, setpoint) },
          },
          termination: overlayTermination(getConfig()),
        });
        break;
      }
      default:
        throw new Error(`Unsupported heating mode: ${mode}`);
    }
  }

  async function setAcMode(ctx, mode, key) {
    lastAcModes.set(key, mode);
    if (mode === AC_MODES.OFF) {
      const acMode = lastAcModes.get(key) || AC_MODES.AUTO;
      const tadoMode = acModeToTado(acMode) || 'AUTO';
      await client.setOverlay(ctx.homeId, ctx.zoneId, {
        setting: {
          type: tadoAcModeToType(tadoMode),
          power: 'OFF',
          mode: tadoMode,
        },
        termination: overlayTermination(getConfig()),
      });
      return;
    }
    const tadoMode = acModeToTado(mode) || 'AUTO';
    const setpoint = lastSetpoints.get(key) ?? currentTarget(ctx);
    if (setpoint == null) {
      throw new Error('Switching AC mode: no target temperature available yet');
    }
    await client.setOverlay(ctx.homeId, ctx.zoneId, {
      setting: {
        type: tadoAcModeToType(tadoMode),
        power: 'ON',
        mode: tadoMode,
        temperature: { celsius: clampTemperature(ctx, setpoint) },
      },
      termination: overlayTermination(getConfig()),
    });
  }

  async function setAcPower(ctx, value, key) {
    if (value === 0) {
      await setAcMode(ctx, AC_MODES.OFF, key);
      return;
    }
    const acMode = lastAcModes.get(key) || AC_MODES.AUTO;
    await setAcMode(ctx, acMode, key);
  }

  function fallbackSetpoint(ctx) {
    return currentTarget(ctx) ?? null;
  }

  function currentTarget(ctx) {
    const latest = getLatest(ctx.key);
    return latest ? latest.targetTemperature : null;
  }

  function clampTemperature(ctx, temperature) {
    const range = getCapabilities(ctx.key);
    const value = round1(temperature);
    if (!range) return value;
    return round1(Math.max(range.min, Math.min(range.max, value)));
  }

  return { handleSetValue };
}

function readParams(device) {
  const params = {};
  for (const p of device.params || []) params[p.name] = p.value;
  if (params.TADO_HOME_ID == null || params.TADO_ZONE_ID == null) return null;
  return {
    homeId: Number(params.TADO_HOME_ID),
    zoneId: Number(params.TADO_ZONE_ID),
    zoneType: params.TADO_ZONE_TYPE || ZONE_TYPES.HEATING,
    key: `${params.TADO_HOME_ID}:${params.TADO_ZONE_ID}`,
  };
}

function overlayTermination(getConfig) {
  const cfg = (getConfig && getConfig()) || {};
  return { typeSkillBasedApp: cfg.overlay_termination || TERMINATION.MANUAL };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}