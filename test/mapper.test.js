import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGladysDevice, zoneToValues } from '../src/gladys/mapper.js';

const ids = {
  device: 'ext:test:SOMEID',
  feature: (k) => `ext:test:SOMEID:${k}`,
};

test('builds a heating-zone thermostat device with the expected features', () => {
  const zone = { id: 1, homeId: 10, type: 'HEATING', name: 'Living room' };
  const capabilities = { temperatures: { celsius: { min: 5, max: 30, step: 0.5 } } };
  const device = buildGladysDevice({ ids, zone, capabilities });

  assert.equal(device.name, 'Living room');
  assert.equal(device.external_id, ids.device);
  assert.equal(device.features.length, 5);

  const byType = Object.fromEntries(device.features.map((f) => [f.type, f]));
  assert.ok(byType['decimal'], 'measured temperature (SENSOR.DECIMAL)');
  assert.ok(byType['target-temperature']);
  assert.ok(byType['mode']);
  assert.ok(byType['operating-state']);

  const target = device.features.find((f) => f.type === 'target-temperature');
  assert.equal(target.min, 5);
  assert.equal(target.max, 30);
  assert.equal(target.read_only, false);

  const mode = device.features.find((f) => f.type === 'mode');
  assert.ok(Array.isArray(mode.supported_options));
  assert.equal(mode.supported_options.length, 3);

  const params = Object.fromEntries(device.params.map((p) => [p.name, p.value]));
  assert.equal(params.TADO_HOME_ID, '10');
  assert.equal(params.TADO_ZONE_ID, '1');
});

test('builds an air-conditioning device and does not expose a heating mode', () => {
  const zone = { id: 9, homeId: 10, type: 'AIR_CONDITIONING', name: 'Bedroom AC' };
  const device = buildGladysDevice({ ids, zone, capabilities: null });
  const byType = Object.fromEntries(device.features.map((f) => [f.type, f.category]));
  assert.equal(byType['target-temperature'], 'air-conditioning');
  assert.equal(byType['mode'], 'air-conditioning');
  assert.equal(byType['binary'], 'air-conditioning');
  assert.equal(byType['operating-state'], undefined);
});

test('zoneToValues drops null readings and rounds temperatures', () => {
  const values = zoneToValues({
    temperature: 20.55,
    humidity: 44.6,
    targetTemperature: 21.04,
    mode: 2,
    running: 1,
  });
  assert.equal(values.temperature, 20.6);
  assert.equal(values.humidity, 44.6);
  assert.equal(values.target, 21);
  assert.equal(values.mode, 2);
  assert.equal(values.running, 1);
});

test('zoneToValues omits unknown subjects (device offline)', () => {
  const values = zoneToValues({
    temperature: null,
    humidity: null,
    targetTemperature: null,
    mode: 1,
    running: 0,
  });
  assert.equal(values.temperature, undefined);
  assert.equal(values.humidity, undefined);
  assert.equal(values.mode, 1);
});