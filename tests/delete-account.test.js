'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const handler = require('../api/delete-account');

const originalFetch = global.fetch;
const originalUrl = process.env.SUPABASE_URL;
const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const originalConsoleError = console.error;
const originalConsoleInfo = console.info;

function request({ method = 'POST', authorization = 'Bearer caller-token', body = {} } = {}) {
  return { method, headers: { authorization }, body };
}

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function fetchResponse({ ok, status, json, text }) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => text || '',
  };
}

test.beforeEach(() => {
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-test-service-role';
  console.error = () => {};
  console.info = () => {};
});

test.afterEach(() => {
  global.fetch = originalFetch;
  console.error = originalConsoleError;
  console.info = originalConsoleInfo;
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey;
});

test('JAPI01 rejects methods other than POST', async () => {
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('unexpected');
  };
  const res = response();
  await handler(request({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: 'Method not allowed' });
  assert.equal(called, false);
});

test('JAPI02 fails safely when server credentials are absent', async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Could not delete your account. Please try again.' });
});

test('JAPI03 requires a Bearer token', async () => {
  const res = response();
  await handler(request({ authorization: '' }), res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Please sign in again to delete your account.' });
});

test('JAPI04 rejects a token Supabase does not verify', async () => {
  global.fetch = async () => fetchResponse({ ok: false, status: 401 });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'Please sign in again to delete your account.' });
});

test('JAPI05 deletes only the identity resolved from the verified token', async () => {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return fetchResponse({
        ok: true,
        status: 200,
        json: { id: 'resolved-user-id' },
      });
    }
    return fetchResponse({ ok: true, status: 200 });
  };
  const res = response();
  await handler(request({ body: { userId: 'attacker-controlled-id' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://project.supabase.co/auth/v1/user');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer caller-token');
  assert.equal(calls[1].url, 'https://project.supabase.co/auth/v1/admin/users/resolved-user-id');
  assert.equal(calls[1].options.method, 'DELETE');
  assert.equal(calls[1].url.includes('attacker-controlled-id'), false);
});

test('JAPI06 maps last-Owner continuity denial to an actionable conflict', async () => {
  let call = 0;
  global.fetch = async () => {
    call += 1;
    if (call === 1) {
      return fetchResponse({ ok: true, status: 200, json: { id: 'last-owner-id' } });
    }
    return fetchResponse({
      ok: false,
      status: 500,
      text: '{"message":"VISTORY_LAST_OWNER_CONTINUITY_REQUIRED"}',
    });
  };
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    error: 'Institutional ownership must be transferred or resolved before deleting this account.',
    code: 'VISTORY_LAST_OWNER_CONTINUITY_REQUIRED',
  });
});

test('JAPI07 keeps unrelated administrative deletion failures generic', async () => {
  let call = 0;
  const logs = [];
  console.error = (...args) => logs.push(args);
  global.fetch = async () => {
    call += 1;
    if (call === 1) {
      return fetchResponse({ ok: true, status: 200, json: { id: 'ordinary-user-id' } });
    }
    return fetchResponse({
      ok: false,
      status: 500,
      text: 'sensitive database detail',
    });
  };
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'Could not delete your account. Please try again.' });
  assert.deepEqual(logs, [['admin delete user failed', 500]]);
});

test('JAPI08 handles an administrative network failure without claiming success', async () => {
  let call = 0;
  global.fetch = async () => {
    call += 1;
    if (call === 1) {
      return fetchResponse({ ok: true, status: 200, json: { id: 'ordinary-user-id' } });
    }
    throw new Error('local simulated network failure');
  };
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'Could not delete your account. Please try again.' });
});
