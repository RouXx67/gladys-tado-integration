import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeZone } from '../src/tado/state.js';

const heatingZone = { id: 1, type: 'HEATING', name: 'Living room' };

test('normalizes a heating zone that is heating manually', () => {
  const state = {
    setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 21 } },
    sensorDataPoints: {
      insideTemperature: { celsius: 20.5, precision: 0.1 },
      humidity: { percentage: 45 },
    },
    activityDataPoints: { heatingPower: { percentage: 40 } },
    overlayType: 'MANUAL',
    link: { state: 'ONLINE' },
  };
  const n = normalizeZone(heatingZone, state);
  assert.equal(n.temperature, 20.5);
  assert.equal(n.humidity, 45);
  assert.equal(n.targetTemperature, 21);
  assert.equal(n.running, 1);
  assert.equal(n.mode, 2); // MANUAL
  assert.equal(n.isOnline, true);
});

test('heating zone following the schedule (no overlay) reports mode SCHEDULE', () => {
  const state = {
    setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 19 } },
    sensorDataPoints: { insideTemperature: { celsius: 20 }, humidity: { percentage: 40 } },
    activityDataPoints: { heatingPower: { percentage: 0 } },
    overlayType: null,
    link: { state: 'ONLINE' },
  };
  const n = normalizeZone(heatingZone, state);
  assert.equal(n.mode, 1); // SCHEDULE
  assert.equal(n.running, 0);
});

test('heating zone turned off via overlay reports mode OFF', () => {
  const state = {
    setting: { type: 'HEATING', power: 'OFF' },
    overlayType: 'MANUAL',
    link: { state: 'ONLINE' },
  };
  const n = normalizeZone(heatingZone, state);
  assert.equal(n.mode, 0); // OFF
});

test('offline device yields null readings and no running flag', () => {
  const state = {
    setting: {},
    sensorDataPoints: {},
    link: { state: 'OFFLINE' },
  };
  const n = normalizeZone(heatingZone, state);
  assert.equal(n.isOnline, false);
  assert.equal(n.temperature, null);
  assert.equal(n.humidity, null);
  assert.equal(n.running, 0);
});

test('maps an air conditioning zone mode to its integer', () => {
  const acZone = { id: 9, type: 'AIR_CONDITIONING', name: 'Bedroom AC' };
  const n = normalizeZone(acZone, {
    setting: { type: 'COOLING', power: 'ON', mode: 'COOL', temperature: { celsius: 23 } },
    overlayType: 'MANUAL',
    link: { state: 'ONLINE' },
  });
  assert.equal(n.mode, 1); // COOL
  assert.equal(n.acMode, 'COOL');
  assert.equal(n.running, 1);
});