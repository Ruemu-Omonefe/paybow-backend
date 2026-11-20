/**
 * Paybow protocol (shared contract with mobile/src/lib/protocol.ts – keep identical).
 *
 * Everything signed is a canonical string:  <TAG>|JSON.stringify([...fields in fixed order])
 *   certificate : PBC1  [sn, aid, nm, wid, pk, iat, exp]                                   (signed by the backend key)
 *   payment     : PB2   [transaction_id, payer_id, payer_name, recipient_id, amount, currency, timestamp, expires_at, reference]
 *   acceptance  : PBA1  [transaction_id, payer_id, recipient_id, amount, currency, accepted_at, reference]
 *   funding     : PBF1  [reference, account_id, amount, currency, verified_at]               (signed by the backend key)
 * Amounts are integer kobo; times are epoch milliseconds; keys/signatures are base64 Ed25519.
 */
import nacl from 'tweetnacl';
import crypto from 'crypto';
import type { Acceptance, Certificate, Payment, SubmittedTransaction } from '../types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/;
const REF_RE = /^[0-9a-f]{16,64}$/;
const WALLET_RE = /^PBW[0-9]{9}$/;

export const certPayload = (c: Omit<Certificate, 'sig'>) => 'PBC1|' + JSON.stringify([c.sn, c.aid, c.nm, c.wid, c.pk, c.iat, c.exp]);
export const paymentPayload = (p: Omit<Payment, 'signature'>) =>
  'PB2|' + JSON.stringify([p.transaction_id, p.payer_id, p.payer_name, p.recipient_id, p.amount, p.currency, p.timestamp, p.expires_at, p.reference]);
export const acceptancePayload = (a: Omit<Acceptance, 'signature' | 'certificate'>) =>
  'PBA1|' + JSON.stringify([a.transaction_id, a.payer_id, a.recipient_id, a.amount, a.currency, a.accepted_at, a.reference]);
export const fundingPayload = (f: { reference: string; account_id: string; amount: number; currency: string; verified_at: number }) =>
  'PBF1|' + JSON.stringify([f.reference, f.account_id, f.amount, f.currency, f.verified_at]);

function b64(b64: unknown, len?: number): Uint8Array | null {
  if (typeof b64 !== 'string') return null;
  const buf = Buffer.from(b64, 'base64');
  if (len && buf.length !== len) return null;
  return new Uint8Array(buf);
}
export const isValidPublicKey = (k: unknown) => !!b64(k, 32);

export function signPayload(payload: string, secretKeyB64: string): string {
  return Buffer.from(nacl.sign.detached(new Uint8Array(Buffer.from(payload, 'utf8')), b64(secretKeyB64, 64)!)).toString('base64');
}
export function verifyPayload(payload: string, sigB64: unknown, publicKeyB64: unknown): boolean {
  try {
    const sig = b64(sigB64, 64);
    const pk = b64(publicKeyB64, 32);
    if (!sig || !pk) return false;
    return nacl.sign.detached.verify(new Uint8Array(Buffer.from(payload, 'utf8')), sig, pk);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- certificates */
export function issueCertificate(
  user: { id: string; name: string; walletId: string },
  publicKey: string,
  serverSecretKey: string,
  now: number,
  validityMs: number
): Certificate {
  const body = { v: 1 as const, sn: crypto.randomBytes(8).toString('hex'), aid: user.id, nm: user.name, wid: user.walletId, pk: publicKey, iat: now, exp: now + validityMs };
  return { ...body, sig: signPayload(certPayload(body), serverSecretKey) };
}

/** Verifies the backend's signature and that the certificate was valid at time `at`. */
export function verifyCertificate(c: Certificate, serverPublicKey: string, at: number, skewMs = 0): boolean {
  if (!c || c.v !== 1) return false;
  if (!verifyPayload(certPayload(c), c.sig, serverPublicKey)) return false;
  return at >= c.iat - skewMs && at <= c.exp + skewMs;
}

export const verifyPayment = (p: Payment, publicKey: string) => verifyPayload(paymentPayload(p), p.signature, publicKey);
export const verifyAcceptance = (a: Acceptance, publicKey: string) => verifyPayload(acceptancePayload(a), a.signature, publicKey);

/** Fingerprint of the full signed payment. Same ID + different fingerprint => CONFLICT. */
export function fingerprint(p: Payment): string {
  return crypto.createHash('sha256').update(`${paymentPayload(p)}|${p.signature}`).digest('hex');
}

export function pickPayment(t: Payment): Payment {
  return {
    transaction_id: t.transaction_id, payer_id: t.payer_id, payer_name: t.payer_name, recipient_id: t.recipient_id, amount: t.amount,
    currency: t.currency, timestamp: t.timestamp, expires_at: t.expires_at, reference: t.reference, signature: t.signature,
  };
}

/* ------------------------------------------------------------- shape validation (untrusted input) */
function certShape(c: any, errors: string[], label: string) {
  if (!c || typeof c !== 'object') return errors.push(`${label} missing`);
  if (c.v !== 1) errors.push(`${label}.v invalid`);
  if (typeof c.sn !== 'string' || c.sn.length < 4 || c.sn.length > 64) errors.push(`${label}.sn invalid`);
  if (!OBJECT_ID_RE.test(String(c.aid))) errors.push(`${label}.aid invalid`);
  if (typeof c.nm !== 'string' || c.nm.length < 1 || c.nm.length > 60) errors.push(`${label}.nm invalid`);
  if (!WALLET_RE.test(String(c.wid))) errors.push(`${label}.wid invalid`);
  if (!isValidPublicKey(c.pk)) errors.push(`${label}.pk invalid`);
  if (!Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp)) errors.push(`${label} times invalid`);
  if (!b64(c.sig, 64)) errors.push(`${label}.sig invalid`);
}

export function validateSubmission(t: any, currency = 'NGN'): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!t || typeof t !== 'object') return { ok: false, errors: ['body must be an object'] };
  if (!UUID_RE.test(String(t.transaction_id))) errors.push('transaction_id must be a UUID v4');
  if (!OBJECT_ID_RE.test(String(t.payer_id))) errors.push('payer_id is invalid');
  if (typeof t.payer_name !== 'string' || t.payer_name.length < 1 || t.payer_name.length > 60) errors.push('payer_name is invalid');
  if (!OBJECT_ID_RE.test(String(t.recipient_id))) errors.push('recipient_id is invalid');
  if (!Number.isSafeInteger(t.amount) || t.amount <= 0) errors.push('amount must be a positive integer (kobo)');
  if (t.currency !== currency) errors.push(`currency must be ${currency}`);
  if (!Number.isSafeInteger(t.timestamp) || t.timestamp <= 0) errors.push('timestamp must be epoch ms');
  if (!Number.isSafeInteger(t.expires_at) || t.expires_at <= 0) errors.push('expires_at must be epoch ms');
  if (!REF_RE.test(String(t.reference))) errors.push('reference must be 16-64 hex chars');
  if (!b64(t.signature, 64)) errors.push('signature must be a base64 Ed25519 signature');
  certShape(t.payer_certificate, errors, 'payer_certificate');
  if (t.acceptance !== undefined && t.acceptance !== null) {
    const a = t.acceptance;
    if (typeof a !== 'object') errors.push('acceptance invalid');
    else {
      if (!UUID_RE.test(String(a.transaction_id))) errors.push('acceptance.transaction_id invalid');
      if (!OBJECT_ID_RE.test(String(a.payer_id)) || !OBJECT_ID_RE.test(String(a.recipient_id))) errors.push('acceptance ids invalid');
      if (!Number.isSafeInteger(a.amount) || !Number.isSafeInteger(a.accepted_at)) errors.push('acceptance numbers invalid');
      if (typeof a.currency !== 'string' || !REF_RE.test(String(a.reference))) errors.push('acceptance fields invalid');
      if (!b64(a.signature, 64)) errors.push('acceptance.signature invalid');
      certShape(a.certificate, errors, 'acceptance.certificate');
    }
  }
  if (t.dependencies !== undefined && t.dependencies !== null) {
    if (!Array.isArray(t.dependencies) || t.dependencies.length > 100 || t.dependencies.some((d: unknown) => typeof d !== 'string' || d.length < 4 || d.length > 64))
      errors.push('dependencies must be an array of IDs');
  }
  return { ok: errors.length === 0, errors };
}

export type { SubmittedTransaction };
