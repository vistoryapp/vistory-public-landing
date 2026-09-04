// Vercel serverless — permanently delete the AUTHENTICATED user's account.
//
// Apple App Review Guideline 5.1.1(v): an app that supports account creation
// must let the user initiate account deletion from within the app. The mobile
// client sends its Supabase access token; we VERIFY it against Supabase, then
// use the service role to delete that auth user. The auth.users → public.users
// cascade invokes the database's account-deletion orchestration first: all
// institution memberships are preflighted, last-Owner continuity is enforced,
// institutional authority is terminated/severed, and provenance is retained.
// Ordinary user-owned rows continue to follow their existing FK behavior.
//
// SECURITY: we NEVER accept a user id from the client — only the id resolved
// from the verified token. Bearer token required; no anonymous path.
//
// Env (Vercel): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (same as scout/moderate).

const GENERIC_ERROR = 'Could not delete your account. Please try again.';
const AUTH_MSG = 'Please sign in again to delete your account.';
const OWNER_CONTINUITY_CODE = 'VISTORY_LAST_OWNER_CONTINUITY_REQUIRED';
const OWNER_CONTINUITY_MSG =
  'Institutional ownership must be transferred or resolved before deleting this account.';

async function verifyUser(supabaseUrl, serviceKey, token) {
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && typeof u.id === 'string' ? u.id : null;
  } catch (e) {
    console.error('delete-account verifyUser failed', e);
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('Missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    res.status(500).json({ error: GENERIC_ERROR });
    return;
  }

  // Identity — Bearer token only, verified against Supabase.
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!bearer) {
    res.status(401).json({ error: AUTH_MSG });
    return;
  }
  const userId = await verifyUser(supabaseUrl, serviceKey, bearer);
  if (!userId) {
    res.status(401).json({ error: AUTH_MSG });
    return;
  }

  // Permanent hard-delete. Database triggers perform the institution-aware
  // preflight and provenance-preserving membership severance atomically inside
  // the Auth deletion transaction before public.users can be removed.
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      if (t.includes(OWNER_CONTINUITY_CODE)) {
        console.info('admin delete user denied: institutional Owner continuity required');
        res.status(409).json({ error: OWNER_CONTINUITY_MSG, code: OWNER_CONTINUITY_CODE });
        return;
      }
      console.error('admin delete user failed', r.status);
      res.status(502).json({ error: GENERIC_ERROR });
      return;
    }
  } catch (e) {
    console.error('admin delete user fetch failed', e);
    res.status(502).json({ error: GENERIC_ERROR });
    return;
  }

  res.status(200).json({ success: true });
};
