import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

import { ZONE_TYPES } from '../tado/constants.js';
import { THERMOSTAT_MODES, AC_MODES } from '../tado/state.js';

// Clamps applied when tado° capabilities are missing (should not happen, but
// keeps the published min/max sane).
const DEFAULT_HEATING_RANGE = { min: 5, max: 30 };
const DEFAULT_AC_RANGE = { min: 16, max: 30 };

const MODE_LABELS = {
  en: ['Off', 'Schedule', 'Manual'],
  fr: ['Éteint', 'Programme', 'Manuel'],
};

const AC_MODE_LABELS = {
  en: ['Off', 'Cool', 'Heat', 'Auto', 'Dry', 'Fan'],
  fr: ['Éteint', 'Froid', 'Chaud', 'Auto', 'Déshu', 'Ventilateur'],
};

/**
 * Build a Gladys device object for one tado° zone using the SDK-fixed
 * feature ids (so the ids stay stable across re-discovery and reconnect).
 */
export function buildGladysDevice({ ids, zone, capabilities }) {
  const isAc = zone.type === ZONE_TYPES.AIR_CONDITIONING;
  const range = parseRange(capabilities, isAc);

  const features = [
    temperatureFeature(ids.feature('temperature')),
    humidityFeature(ids.feature('humidity')),
  ];

  if (isAc) {
    features.push(
      aTTargetFeature(ids.feature('target'), range),
      acModeFeature(ids.feature('mode')),
      acRunningFeature(ids.feature('running')),
    );
  } else {
    features.push(
      thermostatTargetFeature(ids.feature('target'), range),
      thermostatModeFeature(ids.feature('mode')),
      thermostatRunningFeature(ids.feature('running')),
    );
  }

  return {
    name: zone.name,
    external_id: ids.device,
    params: [
      { name: 'TADO_HOME_ID', value: String(zone.homeId) },
      { name: 'TADO_ZONE_ID', value: String(zone.id) },
      { name: 'TADO_ZONE_TYPE', value: zone.type },
    ],
    features,
  };
}

function temperatureFeature(externalId) {
  return {
    name: 'Temperature',
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.CELSIUS,
    min: -40,
    max: 80,
    read_only: true,
    has_feedback: true,
    keep_history: true,
  };
}

function humidityFeature(externalId) {
  return {
    name: 'Humidity',
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    min: 0,
    max: 100,
    read_only: true,
    has_feedback: true,
    keep_history: true,
  };
}

function thermostatTargetFeature(externalId, range) {
  return {
    name: 'Target temperature',
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
    type: DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE,
    unit: DEVICE_FEATURE_UNITS.CELSIUS,
    min: range.min,
    max: range.max,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  };
}

function thermostatModeFeature(externalId) {
  return {
    name: 'Mode',
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
    type: DEVICE_FEATURE_TYPES.THERMOSTAT.MODE,
    min: 0,
    max: 2,
    read_only: false,
    has_feedback: true,
    keep_history: false,
    supported_options: [
      valueOption(THERMOSTAT_MODES.OFF, 1),
      valueOption(THERMOSTAT_MODES.SCHEDULE, 2),
      valueOption(THERMOSTAT_MODES.MANUAL, 3),
    ],
  };
}

function thermostatRunningFeature(externalId) {
  return {
    name: 'Heating',
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
    type: DEVICE_FEATURE_TYPES.THERMOSTAT.OPERATING_STATE,
    min: 0,
    max: 1,
    read_only: true,
    has_feedback: true,
    keep_history: false,
  };
}

function aTTargetFeature(externalId, range) {
  return {
    name: 'Target temperature',
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.AIR_CONDITIONING,
    type: DEVICE_FEATURE_TYPES.AIR_CONDITIONING.TARGET_TEMPERATURE,
    unit: DEVICE_FEATURE_UNITS.CELSIUS,
    min: range.min,
    max: range.max,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  };
}

function acModeFeature(externalId) {
  return {
    name: 'Mode',
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.AIR_CONDITIONING,
    type: DEVICE_FEATURE_TYPES.AIR_CONDITIONING.MODE,
    min: 0,
    max: 5,
    read_only: false,
    has_feedback: true,
    keep_history: false,
    supported_options: [
      valueOption(AC_MODES.OFF, 1, AC_MODE_LABELS),
      valueOption(AC_MODES.COOL, 2, AC_MODE_LABELS),
      valueOption(AC_MODES.HEAT, 3, AC_MODE_LABELS),
      valueOption(AC_MODES.AUTO, 4, AC_MODE_LABELS),
      valueOption(AC_MODES.DRY, 5, AC_MODE_LABELS),
      valueOption(AC_MODES.FAN, 6, AC_MODE_LABELS),
    ],
  };
}

function acRunningFeature(externalId) {
  return {
    name: 'Running',
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.AIR_CONDITIONING,
    type: DEVICE_FEATURE_TYPES.AIR_CONDITIONING.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    has_feedback: true,
    keep_history: false,
  };
}

function valueOption(value, sortOrder, labels = MODE_LABELS) {
  return {
    value,
    label: {
      en: labels.en[value] || String(value),
      fr: labels.fr[value] || String(value),
    },
    sort_order: sortOrder,
  };
}

/**
 * Translate a normalized zone reading (see tado/state.js) into the raw state
 * values by feature key, ready for publishState(s).
 */
export function zoneToValues(normalized) {
  const values = {
    temperature: normalized.temperature,
    humidity: normalized.humidity,
    target: normalized.targetTemperature,
    mode: normalized.mode,
    running: normalized.running,
  };
  // Drop unknown readings (device offline) so we only publish known values.
  const out = {};
  if (values.temperature !== null) out.temperature = round1(values.temperature);
  if (values.humidity !== null) out.humidity = round1(values.humidity);
  if (values.target !== null) out.target = round1(values.target);
  if (values.mode !== null) out.mode = values.mode;
  if (values.running !== null) out.running = values.running;
  return out;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function parseRange(capabilities, isAc) {
  const temp = capabilities && capabilities.temperatures;
  if (temp && temp.celsius && typeof temp.celsius.min === 'number') {
    return {
      min: temp.celsius.min,
      max: temp.celsius.max,
    };
  }
  return isAc ? DEFAULT_AC_RANGE : DEFAULT_HEATING_RANGE;
}