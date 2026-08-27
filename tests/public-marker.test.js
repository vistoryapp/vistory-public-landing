const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { resolvePublicMarker } = require('../api/public-marker');

const QR_ID = '11111111-1111-4111-8111-111111111111';
const MARKER = { title: 'Example Marker', description: 'Public history.', verification_status: 'verified' };

function response(payload, ok = true) { return { ok, json: async () => payload }; }
function resolver(markerPayload = [MARKER]) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return response(markerPayload);
  };
  return { calls, value: resolvePublicMarker({ qrId: QR_ID, fetchImpl, supabaseUrl: 'https://example.supabase.co', serviceKey: 'test' }) };
}

test('published Verified QR exposes only public marker fields', async () => {
  const r = resolver();
  assert.deepEqual(await r.value, { title: 'Example Marker', description: 'Public history.', classification: 'verified' });
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0].url, /rpc\/get_public_published_marker_by_qr/);
  assert.doesNotMatch(r.calls[0].url, /collections|users|partner|evidence/);
  assert.equal(r.calls[0].options.method, 'POST');
  assert.equal(r.calls[0].options.body, JSON.stringify({ p_qr_marker_id: QR_ID }));
});

test('published Preview QR consumes the authoritative server classification', async () => {
  const r = resolver([{ ...MARKER, verification_status: 'preview' }]);
  assert.equal((await r.value).classification, 'preview');
});

test('malformed QR never queries Supabase', async () => {
  let called = false;
  const value = await resolvePublicMarker({ qrId: 'not-a-uuid', fetchImpl: async () => { called = true; }, supabaseUrl: 'https://example.supabase.co', serviceKey: 'test' });
  assert.equal(value, null);
  assert.equal(called, false);
});

test('unpublished, archived, and invalid QR lookups expose no marker content', async () => {
  const r = resolver([]);
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
  assert.deepEqual(config.rewrites, [{ source: '/collect/:qr_id', destination: '/collect' }]);
});

test('public QR resolver uses only the narrow authoritative RPC', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'public-marker.js'), 'utf8');
  assert.match(api, /rpc\/get_public_published_marker_by_qr/);
  assert.doesNotMatch(api, /marker_verification_events/);
  assert.doesNotMatch(api, /rest\/v1\/markers/);
});
