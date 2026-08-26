const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asPublicMarker(marker, event) {
  return {
    title: marker.title,
    description: marker.description || '',
    classification: event && event.action === 'verified' ? 'verified' : 'preview',
  };
}

async function resolvePublicMarker({ qrId, fetchImpl, supabaseUrl, serviceKey }) {
  if (!UUID_RE.test(qrId)) return null;

  const markerUrl = new URL('/rest/v1/markers', supabaseUrl);
  markerUrl.searchParams.set('select', 'id,title,description,content_version');
  markerUrl.searchParams.set('qr_marker_id', `eq.${qrId}`);
  markerUrl.searchParams.set('marker_type', 'eq.historical');
  markerUrl.searchParams.set('content_status', 'eq.published');
  markerUrl.searchParams.set('limit', '1');
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const markerResponse = await fetchImpl(markerUrl, { headers });
  if (!markerResponse.ok) throw new Error('marker lookup failed');
  const markers = await markerResponse.json();
  const marker = markers[0];
  if (!marker) return null;

  const eventUrl = new URL('/rest/v1/marker_verification_events', supabaseUrl);
  eventUrl.searchParams.set('select', 'action');
  eventUrl.searchParams.set('marker_id', `eq.${marker.id}`);
  eventUrl.searchParams.set('content_version', `eq.${marker.content_version}`);
  eventUrl.searchParams.set('order', 'occurred_at.desc,id.desc');
  eventUrl.searchParams.set('limit', '1');
  const eventResponse = await fetchImpl(eventUrl, { headers });
  if (!eventResponse.ok) throw new Error('verification lookup failed');
  const events = await eventResponse.json();
  return asPublicMarker(marker, events[0]);
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
