// Lemon Squeezy, the payment provider (Phase D): what the billing Edge Function needs from it,
// as plain functions (Web Crypto, no Deno or Node API) so the same file runs in the function
// and in the tests (test/billing-lemon.test.js). Another provider replaces this file.

const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();

// X-Signature: the hex HMAC-SHA256 of the raw body with the webhook's signing secret. Compared
// in constant time; without a secret nothing passes.
export async function verifySignature(rawBody, header, secret) {
  if (!secret || typeof header !== 'string' || !/^[0-9a-f]{64}$/.test(header)) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = hex(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

// The delivery's identity for billing_apply (a retry has the same body).
export async function bodyHash(rawBody) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(rawBody)));
}

// A checkout for one variant, tied to the account the function verified (custom.user_id comes
// back in every webhook). The reader's email only prefills the form.
export function checkoutRequest({ apiKey, storeId, variantId, userId, email, testMode, redirectUrl }) {
  if (!userId) throw new Error('a user is required');
  if (!storeId || !variantId) throw new Error('store and variant are required');
  const attributes = { checkout_data: { email: email || undefined, custom: { user_id: userId } }, test_mode: !!testMode };
  if (redirectUrl) attributes.product_options = { redirect_url: redirectUrl };
  return {
    url: 'https://api.lemonsqueezy.com/v1/checkouts',
    init: {
      method: 'POST',
      headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ data: { type: 'checkouts', attributes,
        relationships: { store: { data: { type: 'stores', id: String(storeId) } }, variant: { data: { type: 'variants', id: String(variantId) } } } } })
    }
  };
}

export function checkoutUrl(json) {
  const u = json && json.data && json.data.attributes && json.data.attributes.url;
  return typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null;
}
