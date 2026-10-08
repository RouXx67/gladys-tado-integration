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
export function normalizeZone(zone, zoneState = {}, devices = []) {
  const type = zone.type || ZONE_TYPES.HEATING;
  const setting = zoneState.setting || {};
  const sensor = zoneState.sensorDataPoints || {};
  const activity = zoneState.activityDataPoints || {};
  const linkState = zoneState.link ? zoneState.link.state : 'ONLINE';
  const isOnline = linkState === 'ONLINE';

  let inside = readCelsius(sensor.insideTemperature) ?? readCelsius(sensor.temperature) ?? readCelsius(sensor.measuredTemperature);
  let humidity = readPercentage(sensor.humidity);
  const target = readCelsius(setting.temperature) ?? readCelsius(setting.targetTemperature);

  const running =
    type === ZONE_TYPES.HEATING
      ? (readPercentage(activity.heatingPower) > 0 || (zoneState.overlay && zoneState.overlay.setting && zoneState.overlay.setting.power === 'ON') || (setting.type === 'HEATING' && setting.power === 'ON' && zoneState.overlayType === 'MANUAL') || (setting.power === 'ON' && readPercentage(activity.heatingPower) > 0))
      : setting.power === 'ON';

  const mode = deriveMode(zoneState, setting, type);

  let battery = null;
  for (const d of (devices || [])) {
    if (d) {
      const t = d.type || d.deviceType || d.deviceClass || '';
      if (typeof t === 'string' && (t.includes('RADIO_THERMOSTAT') || t.includes('TRV'))) {
        if (d.batteryState) battery = normalizeBattery(d.batteryState);
        if (d.characteristics && d.characteristics.batteryLevel !== undefined) battery = d.characteristics.batteryLevel;
        if (d.batteryLevel !== undefined) battery = d.batteryLevel;
      }
      if (d.duties && Array.isArray(d.duties)) {
        if (d.duties.includes('ZONE_UI')) {
          if (d.batteryState) battery = normalizeBattery(d.batteryState);
        }
      }
    }
  }

  if (sensor && sensor.attribution) {
    if (Array.isArray(sensor.attribution)) {
      for (const a of sensor.attribution) {
        if (a.batteryState) battery = normalizeBattery(a.batteryState);
        if (a.deviceType && a.deviceType.includes('RADIO_THERMOSTAT')) {
          if (a.batteryState) battery = normalizeBattery(a.batteryState);
        }
      }
    } else if (sensor.attribution.batteryState) {
      battery = normalizeBattery(sensor.attribution.batteryState);
    }
  }

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
    battery,
  };
}

function normalizeBattery(state) {
  if (!state) return null;
  if (state === 'NORMAL' || state === 'FULL') return 100;
  if (state === 'LOW') return 20;
  if (state === 'VERY_LOW') return 10;
  if (state === 'REPLACE') return 5;
  return null;
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
  if (!point) return null;
  if (typeof point.celsius === 'number') return point.celsius;
  if (typeof point.value === 'number') return point.value;
  if (typeof point.temperature === 'number') return point.temperature;
  if (typeof point.targetTemperature === 'number') return point.targetTemperature;
  return null;
}

function readPercentage(point) {
  if (!point) return null;
  if (typeof point.percentage === 'number') return point.percentage;
  if (typeof point.value === 'number') return point.value;
  return null;
}