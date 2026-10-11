// Minimal Web Push (RFC 8291 aes128gcm payload encryption + RFC 8292 VAPID)
// built on WebCrypto, so it runs in the edge runtime without Node shims.

type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;
const JWT_LIFETIME_SECONDS = 12 * 60 * 60;

export interface VapidKeys {
  publicKey: string; // base64url, uncompressed P-256 point (65 bytes)
  privateJwk: JsonWebKey;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function base64UrlEncode(bytes: Bytes): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Bytes {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: base64UrlEncode(raw), privateJwk };
}

async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64UrlEncode(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + JWT_LIFETIME_SECONDS,
    sub: subject,
  })));
  const signingKey = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    encoder.encode(`${header}.${claims}`),
  ));
  return `vapid t=${header}.${claims}.${base64UrlEncode(signature)}, k=${keys.publicKey}`;
}

/** Encrypts the payload for one subscription (single aes128gcm record). */
export async function encryptPayload(target: PushTarget, payload: Bytes): Promise<Bytes> {
  const uaPublic = base64UrlDecode(target.p256dh);
  const authSecret = base64UrlDecode(target.auth);

  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const keyInfo = concat(encoder.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  // 0x02 marks the last (and only) record.
  const plaintext = concat(payload, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export interface PushResult {
  status: number;
  body: string;
}

export async function sendPush(
  target: PushTarget,
  payload: unknown,
  keys: VapidKeys,
  options: { subject: string; ttlSeconds: number; urgency: 'normal' | 'high'; topic?: string },
): Promise<PushResult> {
  const body = await encryptPayload(target, encoder.encode(JSON.stringify(payload)));
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(target.endpoint, keys, options.subject),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(options.ttlSeconds),
    Urgency: options.urgency,
  };
  if (options.topic) headers.Topic = options.topic;
  const res = await fetch(target.endpoint, { method: 'POST', headers, body });
  return { status: res.status, body: res.status >= 400 ? (await res.text()).slice(0, 300) : '' };
}
