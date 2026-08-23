// Production-candidate Vercel handler. PREPARED ONLY; do not deploy without owner approval.
// Request body authority is exactly { event_id }. Every other value is loaded from Supabase.
const crypto = require('node:crypto');
const { authenticateInternalEvent } = require('../lib/collection-worker/internal-auth');
const { generateTrivia } = require('../lib/collection-worker/trivia-provider');

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function dbHeaders(serviceKey, extra = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'content-type': 'application/json',
    ...extra,
  };
}

async function dbRequest(url, serviceKey, path, options = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: dbHeaders(serviceKey, options.headers),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`database ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function rpc(url, serviceKey, name, body) {
  return dbRequest(url, serviceKey, `rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function loadTrustedEvent(url, serviceKey, eventId) {
  const events = await dbRequest(
    url,
    serviceKey,
    `collection_events?event_id=eq.${encodeURIComponent(eventId)}&select=*&limit=1`,
  );
  const event = events?.[0];
  if (!event || event.event_type !== 'collection_completed') throw new Error('invalid event');
  const markers = await dbRequest(
    url,
    serviceKey,
    `markers?id=eq.${encodeURIComponent(event.marker_id)}&select=id,title,description,marker_type&limit=1`,
  );
  const marker = markers?.[0];
  if (!marker) throw new Error('invalid event marker');
  return { event, marker };
}

async function processTrivia(url, serviceKey, apiKey, event, marker) {
  const existing = await dbRequest(
    url,
    serviceKey,
    `trivia_challenges?collection_event_id=eq.${event.event_id}&select=id&limit=1`,
  );
  if (existing?.[0]) return { id: existing[0].id, deduped: true };
  // Preserve the current product's one-question-per-(marker, group) behavior
  // for co-located group collectors. Solo collection events remain independent.
  if (event.group_id) {
    const groupExisting = await dbRequest(
      url,
      serviceKey,
      `trivia_challenges?marker_id=eq.${event.marker_id}&group_id=eq.${event.group_id}&select=id&limit=1`,
    );
    if (groupExisting?.[0]) return { id: groupExisting[0].id, deduped: true };
  }
  const question = await generateTrivia(marker, apiKey);
  const firesAt = new Date(Date.now() + 60 * 60 * 1000);
  const rows = await dbRequest(url, serviceKey, 'trivia_challenges', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      marker_id: event.marker_id,
      collection_event_id: event.event_id,
      group_id: event.group_id,
      ...question,
      fires_at: firesAt.toISOString(),
      closes_at: new Date(firesAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    }),
  });
  return { id: rows?.[0]?.id || null, deduped: false };
}

async function processNotification(url, serviceKey, event, effect, marker) {
  const users = await dbRequest(
    url,
    serviceKey,
    `users?id=eq.${effect.target_user_id}&select=push_token,notifications_enabled&limit=1`,
  );
  const target = users?.[0];
  if (!target?.push_token || target.notifications_enabled === false) return { skipped: true };
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      to: target.push_token,
      title: 'Your group discovered a new site',
      body: `A group member discovered ${marker.title || 'a historical marker'}.`,
      data: { collection_event_id: event.event_id, marker_id: event.marker_id },
    }),
  });
  if (!response.ok) throw new Error(`push provider ${response.status}`);
  return { delivered: true };
}

async function processEvent(eventId) {
  const url = env('SUPABASE_URL');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = env('ANTHROPIC_API_KEY');
  const { event, marker } = await loadTrustedEvent(url, serviceKey, eventId);
  await rpc(url, serviceKey, 'register_collection_event_effects', { p_event_id: eventId });
  const effects = await dbRequest(
    url,
    serviceKey,
    `collection_event_effects?event_id=eq.${eventId}&status=neq.complete&select=*&order=effect_key`,
  );
  const results = [];
  for (const effect of effects || []) {
    const claim = crypto.randomUUID();
    const claimed = await rpc(url, serviceKey, 'claim_collection_event_effect', {
      p_event_id: eventId,
      p_effect_key: effect.effect_key,
      p_claim_token: claim,
    });
    if (!claimed) {
      results.push({ key: effect.effect_key, skipped: true });
      continue;
    }
    try {
      if (effect.effect_type === 'trivia') {
        await processTrivia(url, serviceKey, apiKey, event, marker);
        await rpc(url, serviceKey, 'complete_collection_event_effect', {
          p_event_id: eventId, p_effect_key: effect.effect_key, p_claim_token: claim,
        });
      } else if (effect.effect_type === 'notification') {
        await processNotification(url, serviceKey, event, effect, marker);
        await rpc(url, serviceKey, 'complete_collection_event_effect', {
          p_event_id: eventId, p_effect_key: effect.effect_key, p_claim_token: claim,
        });
      } else {
        await rpc(url, serviceKey, 'execute_collection_event_db_effect', {
          p_event_id: eventId, p_effect_key: effect.effect_key, p_claim_token: claim,
        });
      }
      results.push({ key: effect.effect_key, succeeded: true });
    } catch (error) {
      await rpc(url, serviceKey, 'fail_collection_event_effect', {
        p_event_id: eventId,
        p_effect_key: effect.effect_key,
        p_claim_token: claim,
        p_error: String(error?.message || error),
      }).catch(() => {});
      results.push({ key: effect.effect_key, failed: true });
    }
  }
  return results;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const eventId = typeof body?.event_id === 'string' ? body.event_id : '';
  const secret = process.env.COLLECTION_WORKER_HMAC_SECRET;
  if (!authenticateInternalEvent(req, eventId, secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (process.env.COLLECTION_WORKER_ENABLED !== 'true') {
    return res.status(503).json({ error: 'worker disabled' });
  }
  try {
    const results = await processEvent(eventId);
    const failed = results.some((result) => result.failed);
    return res.status(failed ? 503 : 200).json({ event_id: eventId, results });
  } catch (error) {
    console.error('collection event processing failed', error);
    return res.status(500).json({ error: 'event processing unavailable' });
  }
};

module.exports.processEvent = processEvent;
module.exports.processTrivia = processTrivia;
