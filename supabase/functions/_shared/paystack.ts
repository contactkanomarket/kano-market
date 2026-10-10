const PAYSTACK_API = 'https://api.paystack.co';

export interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

function secretKey(): string {
  const key = Deno.env.get('PAYSTACK_SECRET_KEY');
  if (!key) throw new Error('Paystack secret key not configured');
  return key;
}

export async function paystack<T>(path: string, init: RequestInit = {}): Promise<PaystackResponse<T>> {
  const res = await fetch(`${PAYSTACK_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  return await res.json();
}

export async function verifySignature(body: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secretKey()),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export interface PaystackTransaction {
  status: string;
  reference: string;
  amount: number;
  currency: string;
  paid_at: string | null;
  metadata: Record<string, unknown> | null;
}
