const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asPublicMarker(marker) {
  return {
    title: marker.title,
    description: marker.description || '',
    classification: marker.verification_status,
  };
}

async function resolvePublicMarker({ qrId, fetchImpl, supabaseUrl, serviceKey }) {
  if (!UUID_RE.test(qrId)) return null;

  const markerUrl = new URL('/rest/v1/rpc/get_public_published_marker_by_qr', supabaseUrl);
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const markerResponse = await fetchImpl(markerUrl, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_qr_marker_id: qrId }),
  });
  if (!markerResponse.ok) throw new Error('marker lookup failed');
  const markers = await markerResponse.json();
  return markers[0] ? asPublicMarker(markers[0]) : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const qrId = typeof req.query.qr_id === 'string' ? req.query.qr_id : '';
  if (!UUID_RE.test(qrId)) return res.status(404).json({ error: 'Marker not found' });

  try {
    const marker = await resolvePublicMarker({
      qrId,
      fetchImpl: fetch,
      supabaseUrl: process.env.SUPABASE_URL,
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    res.setHeader('Cache-Control', 'no-store');
    return marker
      ? res.status(200).json(marker)
      : res.status(404).json({ error: 'Marker not found' });
  } catch (error) {
    console.error('public marker lookup failed', error);
    return res.status(503).json({ error: 'Marker details are temporarily unavailable' });
  }
};

module.exports.resolvePublicMarker = resolvePublicMarker;
