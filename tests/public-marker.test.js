const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { resolvePublicMarker } = require('../api/public-marker');

const QR_ID = '11111111-1111-4111-8111-111111111111';
const MARKER = { id: '22222222-2222-4222-8222-222222222222', title: 'Example Marker', description: 'Public history.', content_version: 3, source: 'not-used_demo_' };

function response(payload, ok = true) { return { ok, json: async () => payload }; }
function resolver(eventPayload, markerPayload = [MARKER]) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return response(calls.length === 1 ? markerPayload : eventPayload);
  };
  return { calls, value: resolvePublicMarker({ qrId: QR_ID, fetchImpl, supabaseUrl: 'https://example.supabase.co', serviceKey: 'test' }) };
}

test('published Verified QR exposes only public marker fields', async () => {
  const r = resolver([{ action: 'verified' }]);
  assert.deepEqual(await r.value, { title: 'Example Marker', description: 'Public history.', classification: 'verified' });
  assert.equal(r.calls.length, 2);
  assert.match(r.calls[0].url, /qr_marker_id=eq\.11111111/);
  assert.doesNotMatch(r.calls[0].url, /collections|users|partner|evidence/);
  assert.ok(r.calls.every((call) => !call.options.method || call.options.method === 'GET'));
});

test('published Preview QR is authoritative when its current version has no verified event', async () => {
  const r = resolver([]);
  assert.equal((await r.value).classification, 'preview');
});

test('malformed QR never queries Supabase', async () => {
  let called = false;
  const value = await resolvePublicMarker({ qrId: 'not-a-uuid', fetchImpl: async () => { called = true; }, supabaseUrl: 'https://example.supabase.co', serviceKey: 'test' });
  assert.equal(value, null);
  assert.equal(called, false);
});

test('unpublished, archived, and invalid QR lookups expose no marker content', async () => {
  const r = resolver([], []);
  assert.equal(await r.value, null);
  assert.equal(r.calls.length, 1);
});

test('public store copy uses both live destinations and contains no Android launch claim', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const collect = fs.readFileSync(path.join(__dirname, '..', 'collect.html'), 'utf8');
  const apple = 'https://apps.apple.com/us/app/vistory-visit-history/id6778489374';
  const google = 'https://play.google.com/store/apps/details?id=com.vistory.app';
  assert.equal(index.split(apple).length - 1, 4);
  assert.equal(index.split(google).length - 1, 4);
  assert.ok(collect.includes(apple));
  assert.ok(collect.includes(google));
  assert.doesNotMatch(index, /Android.{0,30}(coming soon|waitlist|launch)/i);
  assert.match(index, /within 25 meters/i);
  assert.match(collect, /physically within 25 meters/i);
});

test('public QR route is rewritten to the informational landing page', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.deepEqual(config.rewrites, [{ source: '/collect/:qr_id', destination: '/collect.html' }]);
});
