import { ZONE_TYPES } from './constants.js';

// Mode values published on the Gladys `THERMOSTAT.MODE` feature (documented
// integers, consistent between discovery and state publishing).
export const THERMOSTAT_MODES = {
  OFF: 0, // tado° overlay with power OFF
  SCHEDULE: 1, // no overlay -> following the tado° schedule
  MANUAL: 2, // tado° overlay holding a temperature
};

// Mode values published on the `AIR_CONDITIONING.MODE` feature, mapped onto
// the tado° AC operating modes.
export const AC_MODES = {
  OFF: 0,
  COOL: 1,
  HEAT: 2,
  AUTO: 3,
  DRY: 4,
  FAN: 5,
};

const AC_MODE_TO_TADO = {
  [AC_MODES.COOL]: 'COOL',
  [AC_MODES.HEAT]: 'HEAT',
  [AC_MODES.AUTO]: 'AUTO',
  [AC_MODES.DRY]: 'DRY',
  [AC_MODES.FAN]: 'FAN',
};

const TADO_AC_MODE_TO_TYPE = {
  COOL: 'COOLING',
  HEAT: 'HEATING',
  AUTO: 'AUTO',
  DRY: 'DRY',
  FAN: 'FAN',
};

/**
 * Normalize a single tado° zone + its /state payload into a flat, readable
 * structure used both for discovery defaults and for state publishing.
 */
export function normalizeZone(zone, zoneState = {}) {
  const type = zone.type || ZONE_TYPES.HEATING;
  const setting = zoneState.setting || {};
  const sensor = zoneState.sensorDataPoints || {};
  const activity = zoneState.activityDataPoints || {};
  const linkState = zoneState.link ? zoneState.link.state : 'ONLINE';
  const isOnline = linkState === 'ONLINE';

  const inside = readCelsius(sensor.insideTemperature);
  const humidity = readPercentage(sensor.humidity);
  const target = readCelsius(setting.temperature);

  const running =
    type === ZONE_TYPES.HEATING
      ? readPercentage(activity.heatingPower) > 0
      : setting.power === 'ON';

  const mode = deriveMode(zoneState, setting, type);

  return {
    homeId: zone.homeId,
    zoneId: zone.id,
    type,
    name: zone.name,
    temperature: isOnline ? inside : null,
    humidity: isOnline ? humidity : null,
    targetTemperature: isOnline ? target : null,
    running: isOnline ? (running ? 1 : 0) : 0,
    mode,
    acMode: setting.mode || null,
    isOnline,
    openWindowDetected: Boolean(zoneState.openWindowDetected),
    overlayType: zoneState.overlayType || null,
  };
}

export function deriveMode(zoneState, setting, type) {
  const overlayType = zoneState.overlayType || null;
  if (type === ZONE_TYPES.AIR_CONDITIONING) {
    const tadoMode = setting.mode;
    const mapped = Object.keys(AC_MODE_TO_TADO).find(
      (k) => AC_MODE_TO_TADO[k] === tadoMode,
    );
    if (tadoMode && mapped !== undefined) {
      return Number(mapped);
    }
    if (!overlayType || setting.power !== 'ON') return AC_MODES.OFF;
    return AC_MODES.AUTO;
  }
  // HEATING (and HOT_WATER fallback)
  if (!overlayType) return THERMOSTAT_MODES.SCHEDULE;
  if (setting.power === 'OFF') return THERMOSTAT_MODES.OFF;
  return THERMOSTAT_MODES.MANUAL;
}

export function acModeToTado(modeInteger) {
  return AC_MODE_TO_TADO[modeInteger];
}

export function tadoAcModeToType(tadoMode) {
  return TADO_AC_MODE_TO_TYPE[tadoMode] || 'AUTO';
}

function readCelsius(point) {
  if (point && typeof point.celsius === 'number') return point.celsius;
  if (point && typeof point.value === 'number') return point.value;
  return null;
}

function readPercentage(point) {
  if (point && typeof point.percentage === 'number') return point.percentage;
  return null;
}