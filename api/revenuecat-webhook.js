// Vercel serverless function — RevenueCat webhook for Vistory.
//
// RevenueCat posts subscription lifecycle events here (initial purchase,
// renewal, cancellation, expiration, billing issue, product change, transfer).
// This handler is the SERVER-SIDE source of truth that keeps Supabase in sync
// independently of the mobile client.
//
// Tier architecture (Phase 9 owner decision):
//   - users.subscription_tier is the SINGLE canonical tier the whole app reads
//     (and lib/streak.ts grace logic). This handler writes it.
//   - The subscriptions table holds RevenueCat billing METADATA only. This
//     handler upserts it (requires the UNIQUE(user_id) constraint from
//     Migration 016 for on_conflict=user_id).
//
// Env (set in Vercel dashboard):
//   REVENUECAT_WEBHOOK_SECRET  — Authorization header value set in RevenueCat → Integrations → Webhooks
//   SUPABASE_URL               — already set (shared with trivia-generate.js)
//   SUPABASE_SERVICE_ROLE_KEY  — service role key (server-side only, never shipped to client)
//
// Configure the webhook URL in RevenueCat: https://vistoryapp.com/api/revenuecat-webhook

function tierFromEntitlements(ids) {
  if (!Array.isArray(ids)) return 'free';
  if (ids.includes('historian')) return 'historian';
  if (ids.includes('explorer')) return 'explorer';
  return 'free';
}

function platformFromStore(store) {
  if (store === 'PLAY_STORE') return 'android';
  if (store === 'APP_STORE' || store === 'MAC_APP_STORE') return 'ios';
  return 'web';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !supabaseUrl || !serviceKey) {
    console.error('Missing env: REVENUECAT_WEBHOOK_SECRET / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  // Verify the shared secret RevenueCat sends in the Authorization header.
  if (req.headers['authorization'] !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const event = (body && body.event) || body || {};

  const userId = event.app_user_id;
  const type = event.type;

  // Non-subscription events must NOT touch users.subscription_tier or the
  // subscriptions table. NON_RENEWING_PURCHASE = consumables (streak freeze /
  // repair) — handled entirely client-side in streak.tsx; TEST = RevenueCat's
  // test ping. Neither carries a subscription entitlement, so processing them
  // here computes tier='free' and would wrongly DOWNGRADE the buyer's canonical
  // tier (then 502 on the subscriptions upsert). Acknowledge with 200 and ignore.
  const IGNORED_EVENT_TYPES = new Set(['NON_RENEWING_PURCHASE', 'TEST']);
  if (IGNORED_EVENT_TYPES.has(type)) {
    res.status(200).json({ received: true, ignored: type });
    return;
  }

  if (!userId) {
    res.status(400).json({ error: 'Missing app_user_id' });
    return;
  }

  const entitlementIds =
    event.entitlement_ids || (event.entitlement_id ? [event.entitlement_id] : []);

  let tier = tierFromEntitlements(entitlementIds);
  let status = event.period_type === 'TRIAL' ? 'trialing' : 'active';
  let cancelledAt = null;

  if (type === 'EXPIRATION') {
    // Entitlement lapsed — drop to free.
    tier = 'free';
    status = 'expired';
  } else if (type === 'CANCELLATION') {
    // Auto-renew turned off; access continues until expiration, so tier stays.
    status = 'cancelled';
    cancelledAt = new Date().toISOString();
  }

  const nowIso = new Date().toISOString();
  const expiresAt = event.expiration_at_ms
    ? new Date(event.expiration_at_ms).toISOString()
    : null;

  const sbHeaders = {
    'Content-Type': 'application/json',
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };

  // 1) Canonical tier on the users table.
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/users?id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ subscription_tier: tier }),
      },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('users tier update failed', r.status, text);
      res.status(502).json({ error: 'tier sync failed' });
      return;
    }
  } catch (e) {
    console.error('users tier update threw', e);
    res.status(502).json({ error: 'tier sync failed' });
    return;
  }

  // 2) Billing metadata on the subscriptions table (upsert on user_id).
  const subRow = {
    user_id: userId,
    tier,
    platform: platformFromStore(event.store),
    status,
    product_id: event.product_id || null,
    revenuecat_customer_id: userId,
    expires_at: expiresAt,
    trial_ends_at: event.period_type === 'TRIAL' ? expiresAt : null,
    cancelled_at: cancelledAt,
    last_event: type || null,
    updated_at: nowIso,
  };

  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/subscriptions?on_conflict=user_id`, {
      method: 'POST',
      headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(subRow),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('subscriptions upsert failed', r.status, text);
      // Non-fatal for tier truth (users already updated), but surface so RC retries.
      res.status(502).json({ error: 'metadata sync failed' });
      return;
    }
  } catch (e) {
    console.error('subscriptions upsert threw', e);
    res.status(502).json({ error: 'metadata sync failed' });
    return;
  }

  res.status(200).json({ received: true });
};
