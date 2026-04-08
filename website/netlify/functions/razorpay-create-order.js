/**
 * Creates a Razorpay order (server-side). Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
 * Body JSON: { amountPaise, siteOrderId, currency? }
 */
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const amountPaise = Number(body.amountPaise);
  const siteOrderId = body.siteOrderId;
  if (!Number.isFinite(amountPaise) || amountPaise < 100 || !siteOrderId) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'amountPaise (min 100) and siteOrderId required' }),
    };
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return {
      statusCode: 503,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Razorpay keys not configured on server' }),
    };
  }

  const receipt = String(siteOrderId)
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 40) || 'rcpt';

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: Math.round(amountPaise),
      currency: body.currency || 'INR',
      receipt,
      notes: { site_order_id: String(siteOrderId) },
    }),
  });

  const data = await res.json().catch(function () {
    return {};
  });
  if (!res.ok) {
    const msg = data.error && (data.error.description || data.error.reason)
      ? data.error.description || data.error.reason
      : data.message || 'Razorpay API error';
    return {
      statusCode: res.status >= 400 && res.status < 600 ? res.status : 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: msg }),
    };
  }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      orderId: data.id,
      amount: data.amount,
      currency: data.currency,
      keyId,
    }),
  };
};
