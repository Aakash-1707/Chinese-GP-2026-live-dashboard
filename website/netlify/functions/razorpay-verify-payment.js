/**
 * Verifies Razorpay signature and marks the Supabase order Paid (service role).
 * Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Body JSON: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
const crypto = require('crypto');

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

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const supabaseUrl = (process.env.SUPABASE_URL || process.env.RRM_SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const razorpay_order_id = payload.razorpay_order_id;
  const razorpay_payment_id = payload.razorpay_payment_id;
  const razorpay_signature = payload.razorpay_signature;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing razorpay_order_id, razorpay_payment_id, or razorpay_signature' }),
    };
  }

  if (!keySecret) {
    return {
      statusCode: 503,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Razorpay secret not configured' }),
    };
  }

  const signInput = razorpay_order_id + '|' + razorpay_payment_id;
  const expected = crypto.createHmac('sha256', keySecret).update(signInput).digest('hex');
  if (expected !== razorpay_signature) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid payment signature' }),
    };
  }

  if (!keyId) {
    return {
      statusCode: 503,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Razorpay key id not configured' }),
    };
  }

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const ordRes = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(razorpay_order_id)}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const ord = await ordRes.json().catch(function () {
    return {};
  });
  const siteOrderId = ord.notes && ord.notes.site_order_id;
  if (!siteOrderId) {
    return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not resolve site order from Razorpay order' }),
    };
  }

  if (!supabaseUrl || !serviceKey) {
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        siteOrderId,
        warning: 'SUPABASE_SERVICE_ROLE_KEY or SUPABASE_URL missing — order not updated in database',
      }),
    };
  }

  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/orders?id=eq.${encodeURIComponent(siteOrderId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        status: 'Paid',
        payment_label: 'Razorpay',
        payment_method: 'razorpay',
        payment_reference: razorpay_payment_id,
      }),
    }
  );

  if (!patchRes.ok) {
    const detail = await patchRes.text();
    return {
      statusCode: 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to update order', detail: detail.slice(0, 500) }),
    };
  }

  return {
    statusCode: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, siteOrderId }),
  };
};
