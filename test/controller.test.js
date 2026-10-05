import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TadoController } from '../src/gladys/controller.js';

function fakeGladys() {
  const calls = { devices: [], transports: [], states: [], status: [] };
  const gladys = {
    externalIds(type, platformId) {
      const base = `ext:test:${type}:${platformId}`;
      return { device: base, feature: (k) => `${base}:${k}` };
    },
    publishDiscoveredDevices: async (devices) => {
      calls.devices = devices;
    },
    publishTransports: async (transports) => {
      calls.transports = transports;
    },
    publishStates: async (states) => {
      calls.states.push(...states);
    },
    setConnectionStatus: async (connected, message) => {
      calls.status.push({ connected, message });
    },
    calls,
  };
  return gladys;
}

function heatingHomeClient({ generation = 'V3' } = {}) {
  // One classic home with a heating zone and an AC zone + one hot-water zone,
  // plus a tado° X home that must be skipped.
  const zoneState = {
    setting: { type: 'HEATING', power: 'ON', temperature: { celsius: 21 } },
    sensorDataPoints: {
      insideTemperature: { celsius: 20.4, precision: 0.1 },
      humidity: { percentage: 46 },
    },
    activityDataPoints: { heatingPower: { percentage: 55 } },
    overlayType: 'MANUAL',
    link: { state: 'ONLINE' },
  };
  return {
    stateSeq: 0,
    async getMe() {
      return { homes: [{ id: 10 }, { id: 999 }] };
    },
    async getHome(id) {
      if (id === 999) return { id: 999, name: 'My X Home', generation: 'LINE_X' };
      return { id: 10, name: 'My Home', generation };
    },
    async getZones(id) {
      if (id === 999) return [];
      return [
        { id: 1, type: 'HEATING', name: 'Living room' },
        { id: 2, type: 'HOT_WATER', name: 'Hot water' },
        { id: 3, type: 'AIR_CONDITIONING', name: 'Bedroom AC' },
      ];
    },
    async getZoneState(_homeId, zoneId) {
      if (zoneId === 3) {
        return {
          setting: { type: 'COOLING', power: 'ON', mode: 'COOL', temperature: { celsius: 23 } },
          link: { state: 'ONLINE' },
          overlayType: 'MANUAL',
        };
      }
      return zoneState;
    },
    async getZoneCapabilities(_homeId, zoneId) {
      if (zoneId === 3) return { temperatures: { celsius: { min: 16, max: 30, step: 1 } } };
      return { temperatures: { celsius: { min: 5, max: 30, step: 0.5 } } };
    },
  };
}

test('discovery publishes every supported zone as a Gladys device (skips X and hot water)', async () => {
  const gladys = fakeGladys();
  const client = heatingHomeClient();
  const controller = new TadoController({
    gladys,
    client,
    tokenManager: tokenManagerStub(),
    logger: fakeLogger(),
  });
  controller.applyConfig({});

  await controller.discover();

  const names = gladys.calls.devices.map((d) => d.name);
  assert.deepEqual(names.sort(), ['Bedroom AC', 'Living room']);
  assert.equal(gladys.calls.transports.length, 2);
  for (const t of gladys.calls.transports) assert.equal(t.transport, 'cloud');
});

test('pollOnce publishes only changed states and deduplicates identical ones', async () => {
  const gladys = fakeGladys();
  const client = heatingHomeClient();
  const controller = new TadoController({
    gladys,
    client,
    tokenManager: tokenManagerStub(),
    logger: fakeLogger(),
  });
  controller.applyConfig({});
  await controller.discover();

  const first = await controller.pollOnce();
  assert.equal(first.anyRunning, true);
  assert.ok(gladys.calls.states.length > 0, 'should publish states on the first pass');

  const statusesAfterFirst = gladys.calls.states.length;
  const second = await controller.pollOnce();
  assert.equal(gladys.calls.states.length, statusesAfterFirst, 'no duplicate publish on second pass');
  assert.equal(second.anyRunning, true);
});

function tokenManagerStub() {
  return { hasSession: () => true, disconnect: () => {} };
}

function fakeLogger() {
  const c = () => fakeLogger();
  return { child: c, info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}