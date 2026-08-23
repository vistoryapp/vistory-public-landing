const crypto = require('node:crypto');

const MAX_SKEW_MS = 5 * 60 * 1000;

function expectedSignature(eventId, timestamp, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${eventId}`)
    .digest('hex');
}

function timingSafeHexEqual(actual, expected) {
  if (typeof actual !== 'string' || !/^[0-9a-f]{64}$/i.test(actual)) return false;
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authenticateInternalEvent(req, eventId, secret) {
  if (!eventId || !secret) return false;
  const timestamp = String(req.headers['x-vistory-worker-timestamp'] || '');
  const signature = String(req.headers['x-vistory-worker-signature'] || '');
  if (!/^\d{13}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > MAX_SKEW_MS) return false;
  return timingSafeHexEqual(
    signature,
    expectedSignature(eventId, timestamp, secret),
  );
}

module.exports = { authenticateInternalEvent, expectedSignature };
