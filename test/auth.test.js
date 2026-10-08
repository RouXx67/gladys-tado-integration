import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TadoTokenManager } from '../src/tado/auth.js';
import { createRawHttp, AUTH_HEADERS } from '../src/tado/http.js';

let now = Date.UTC(2026, 0, 1, 12, 0, 0);

function fakeHttp(responses) {
  const calls = [];
  return {
    request: async ({ url, method }) => {
      calls.push({ url, method });
      const r = responses[`${method} ${url}`] || responses[url];
      if (!r) return { status: 404, data: { error: 'not_found' } };
      return typeof r === 'function' ? r() : r;
    },
    calls,
  };
}

const deviceAuthUrl = 'https://login.tado.com/oauth2/device_authorize';
const tokenUrl = 'https://login.tado.com/oauth2/token';

test('starts the device flow and returns a verification URI', async () => {
  const http = fakeHttp({
    [deviceAuthUrl]: () => ({
      status: 200,
      data: {
        device_code: 'abcd',
        user_code: 'XKQZ',
        verification_uri: 'https://login.tado.com/oauth2/device',
        verification_uri_complete: 'https://login.tado.com/oauth2/device?user_code=XKQZ',
        expires_in: 300,
        interval: 5,
      },
    }),
  });
  const m = new TadoTokenManager({ http, persist: async () => {}, logger: fakeLogger(), now: () => now });
  const out = await m.start();
  assert.equal(out.userCode, 'XKQZ');
  assert.match(out.verificationUri, /user_code=XKQZ/);
  m.disconnect();
});

test('approval via polling persists a refresh token and yields an access token', async () => {
  let persisted = null;
  const http = fakeHttp({
    [deviceAuthUrl]: () => ({
      status: 200,
      data: {
        device_code: 'dc1',
        user_code: 'AAAA',
        verification_uri_complete: 'https://login.tado.com/oauth2/device?user_code=AAAA',
        expires_in: 300,
        interval: 1,
      },
    }),
    [tokenUrl]: () => ({
      status: 200,
      data: {
        access_token: 'at1',
        refresh_token: 'rt1',
        expires_in: 3600,
        token_type: 'Bearer',
        userId: 9,
      },
    }),
  });
  const m = new TadoTokenManager({
    http,
    persist: async (rt) => {
      persisted = rt;
    },
    logger: fakeLogger(),
    now: () => now,
  });
  await m.start();
  await m._pollOnce();

  assert.equal(persisted, 'rt1');
  const token = await m.getValidAccessToken();
  assert.equal(token, 'at1');
  m.disconnect();
});

test('polls again while the user has not approved yet', async () => {
  let approvals = 0;
  const http = fakeHttp({
    [deviceAuthUrl]: () => ({
      status: 200,
      data: {
        device_code: 'dc2',
        user_code: 'BBBB',
        verification_uri_complete: 'https://login.tado.com/oauth2/device?user_code=BBBB',
        expires_in: 300,
        interval: 1,
      },
    }),
    [tokenUrl]: () => {
      approvals += 1;
      if (approvals === 1) return { status: 400, data: { error: 'authorization_pending' } };
      return {
        status: 200,
        data: { access_token: 'at2', refresh_token: 'rt2', expires_in: 3600, token_type: 'Bearer' },
      };
    },
  });
  const m = new TadoTokenManager({ http, persist: async () => {}, logger: fakeLogger(), now: () => now });
  await m.start();
  await m._pollOnce(); // pending -> no crash
  await m._pollOnce(); // approved
  assert.equal(await m.getValidAccessToken(), 'at2');
  m.disconnect();
});

test('restores a persisted refresh token and refreshes the access token', async () => {
  const http = fakeHttp({
    [tokenUrl]: () => ({
      status: 200,
      data: { access_token: 'at3', refresh_token: 'rt3', expires_in: 3600, token_type: 'Bearer' },
    }),
  });
  const m = new TadoTokenManager({ http, persist: async () => {}, logger: fakeLogger(), now: () => now });
  const ok = await m.restore('rt2');
  assert.equal(ok, true);
  // store refresh_token grant request
  const refreshCall = http.calls.find((c) => c.method === 'POST' && c.url === tokenUrl);
  assert.ok(refreshCall);
  assert.equal(await m.getValidAccessToken(), 'at3');
});

test('drops the session when a refresh token is rejected', async () => {
  const http = fakeHttp({
    [tokenUrl]: () => ({ status: 400, data: { error: 'invalid_grant' } }),
  });
  const m = new TadoTokenManager({ http, persist: async () => {}, logger: fakeLogger(), now: () => now });
  const ok = await m.restore('bad-refresh-token');
  assert.equal(ok, false);
  assert.equal(m.hasSession(), false);
});

function fakeLogger() {
  return {
    child: () => fakeLogger(),
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  };
}