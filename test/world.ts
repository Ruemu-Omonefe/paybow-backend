/** Test fixtures: backend signing key, users with keys + certificates, payment/acceptance builders. */
import crypto from 'crypto';
import nacl from 'tweetnacl';
import * as protocol from '../src/lib/protocol';
import { createTransactionService } from '../src/services/transactionService';
import { createFundingService } from '../src/services/fundingService';
import type { Acceptance, Certificate, SubmittedTransaction } from '../src/types';
import { createMemoryRepo } from './memoryRepo';

export const T0 = 1_800_000_000_000;
export const oid = () => crypto.randomBytes(12).toString('hex');
export const uuid = () => crypto.randomUUID();
export const kobo = (naira: number) => naira * 100;

export function createWorld() {
  const server = nacl.sign.keyPair();
  const serverSecretKey = Buffer.from(server.secretKey).toString('base64');
  const serverPublicKey = Buffer.from(server.publicKey).toString('base64');
  const config = {
    currency: 'NGN', minAmount: 10_000, maxAmount: 50_000_000, minFunding: 10_000, maxFunding: 50_000_000, maxQrWindowMs: 600_000,
    maxSyncAgeMs: 7 * 24 * 3600_000, clockSkewMs: 120_000, serverPublicKey, serverSecretKey,
  };
  let clock = T0;
  const now = () => clock;
  const repo = createMemoryRepo();
  const txs = createTransactionService(repo, config, now);
  const funding = createFundingService(repo, config, (u) => txs.reevaluateDeferred(u), undefined, now);
  let walletCounter = 100_000_000;

  function user(name: string) {
    const kp = nacl.sign.keyPair();
    const id = oid();
    const publicKey = Buffer.from(kp.publicKey).toString('base64');
    const walletId = `PBW${walletCounter++}`;
    repo.addUser({ id, name, walletId, publicKey, status: 'active' });
    const cert = protocol.issueCertificate({ id, name, walletId }, publicKey, serverSecretKey, clock - 3600_000, 30 * 24 * 3600_000);
    repo.addCertificate(id, publicKey);
    return { id, name, walletId, kp, publicKey, cert, auth: { id, name } };
  }
  type U = ReturnType<typeof user>;

  /** Sender-side submission: a signed payment + certificate (+ dependencies). */
  function payment(from: U, to: U, amountKobo: number, over: Partial<SubmittedTransaction> = {}): SubmittedTransaction {
    const p = {
      transaction_id: uuid(), payer_id: from.id, payer_name: from.name, recipient_id: to.id, amount: amountKobo, currency: 'NGN',
      timestamp: clock - 60_000, expires_at: clock + 240_000, reference: crypto.randomBytes(12).toString('hex'), ...over,
    };
    const signature = over.signature || Buffer.from(nacl.sign.detached(new Uint8Array(Buffer.from(protocol.paymentPayload(p))), from.kp.secretKey)).toString('base64');
    return { ...p, signature, payer_certificate: over.payer_certificate || from.cert };
  }

  /** Receiver-side submission: same payment + the receiver's signed acceptance record. */
  function received(p: SubmittedTransaction, to: U, acceptedAt = p.timestamp + 30_000, certificate: Certificate = to.cert, signer: U = to): SubmittedTransaction {
    const body = { transaction_id: p.transaction_id, payer_id: p.payer_id, recipient_id: p.recipient_id, amount: p.amount, currency: p.currency, accepted_at: acceptedAt, reference: p.reference };
    const signature = Buffer.from(nacl.sign.detached(new Uint8Array(Buffer.from(protocol.acceptancePayload(body))), signer.kp.secretKey)).toString('base64');
    const acceptance: Acceptance = { ...body, signature, certificate };
    const { dependencies: _d, ...rest } = p;
    return { ...rest, acceptance };
  }

  async function fund(u: U, amountKobo: number) {
    const rec = await funding.initiate(u.auth, amountKobo);
    await funding.simulatePayment(u.auth, rec.reference);
    const conf = await funding.verify(u.auth, rec.reference);
    const res = await funding.applyOnSync(u.auth, { reference: rec.reference, amount: amountKobo });
    return { rec, conf, res };
  }

  return {
    repo, txs, funding, config, user, payment, received, fund, now,
    advance: (ms: number) => { clock += ms; },
    balance: (u: U) => repo._balances.get(u.id)!,
    total: () => [...repo._balances.values()].reduce((a, b) => a + b, 0),
  };
}
