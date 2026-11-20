/**
 * Transaction service – the backend is the authoritative source of transaction status.
 * The backend wallet is only a MIRROR of what devices report; it is updated from verified
 * ledger entries, exactly once per entry (unique ledger key), never by overwriting balances.
 *
 * Per-transaction lifecycle (backend states):
 *   DEFERRED   evidence is valid but the sender's mirror cannot cover it yet (earlier transactions /
 *              funding the spend depends on have not synchronized) – nothing applied, retried automatically
 *   UNRESOLVED sender's debit applied, no receiver record yet (receiver may have scanned it offline)
 *   CONFIRMED  sender debit + receiver credit applied (receiver acceptance record verified)
 *   REFUNDED   expired payment, receiver established as NOT credited -> one refund to the sender
 *   REJECTED / CONFLICT  kept for investigation
 *
 * Each side may submit the same transaction (sender: payment + dependencies; receiver: payment + signed
 * acceptance). Whoever arrives first, the debit and the credit are each applied at most once.
 */
import * as protocol from '../lib/protocol';
import { KeyedMutex } from '../lib/mutex';
import type { AuthUser, Config, Payment, ProcessResult, RefundRecord, Repo, StoredTx, SubmittedTransaction, TxState } from '../types';

type Cfg = Pick<Config, 'currency' | 'minAmount' | 'maxAmount' | 'maxQrWindowMs' | 'maxSyncAgeMs' | 'clockSkewMs' | 'serverPublicKey'>;
const FINAL: TxState[] = ['CONFIRMED', 'REJECTED', 'CONFLICT', 'REFUNDED'];
const MAX_CASCADE_DEPTH = 25;

export interface TransactionService {
  processOne(user: AuthUser, raw: unknown, deviceId?: string | null): Promise<ProcessResult>;
  /** Called when a device finished a COMPLETE synchronization (nothing left pending on that device). */
  completeSync(userId: string): Promise<void>;
  /** Re-evaluate DEFERRED transactions of `userId` as payer (call after their mirror balance grew). */
  reevaluateDeferred(userId: string, depth?: number): Promise<void>;
  viewFor(doc: StoredTx, userId: string): ProcessResult;
}

export function createTransactionService(repo: Repo, config: Cfg, now: () => number = () => Date.now()): TransactionService {
  const mutex = new KeyedMutex();
  const skew = config.clockSkewMs;

  function viewFor(doc: StoredTx, userId: string, duplicate = false): ProcessResult {
    const isPayer = userId === doc.payer_id;
    // a receiver can never be "refunded": report the clash instead
    const status: TxState = doc.state === 'REFUNDED' && !isPayer ? 'CONFLICT' : doc.state;
    const reason = doc.state === 'REFUNDED' && !isPayer ? 'This transaction was already refunded to the sender' : doc.reason;
    return { transaction_id: doc.transaction_id, status, reason, duplicate, processed_at: doc.updated_at, refund: isPayer ? doc.refund : null };
  }

  const save = async (doc: StoredTx) => {
    doc.updated_at = now();
    await repo.saveTx(doc);
  };

  /* ---------------------------------------------------------------- evidence validation */
  async function validateEvidence(p: Payment & { payer_certificate: SubmittedTransaction['payer_certificate'] }): Promise<string | null> {
    if (p.payer_id === p.recipient_id) return 'Payer and recipient cannot be the same account';
    const [payer, recipient] = await Promise.all([repo.findUser(p.payer_id), repo.findUser(p.recipient_id)]);
    if (!payer || payer.status !== 'active') return 'Sender account not found or inactive';
    if (!recipient || recipient.status !== 'active') return 'Receiver account not found or inactive';
    if (p.amount < config.minAmount || p.amount > config.maxAmount) return `Amount outside allowed limits (${config.minAmount}-${config.maxAmount} kobo)`;

    const cert = p.payer_certificate;
    if (!protocol.verifyCertificate(cert, config.serverPublicKey, p.timestamp, skew)) return 'Invalid or expired sender certificate';
    if (cert.aid !== p.payer_id || cert.nm !== p.payer_name) return 'Sender certificate does not match the payment';
    if (!(await repo.hasCertificate(cert.aid, cert.pk))) return 'Sender certificate was not issued by this backend';
    if (!protocol.verifyPayment(p, cert.pk)) return 'Invalid signature: payment was not signed by the sender';

    const n = now();
    if (p.expires_at <= p.timestamp || p.expires_at - p.timestamp > config.maxQrWindowMs) return 'Invalid expiry window';
    if (p.timestamp > n + skew) return 'Transaction timestamp is in the future';
    if (n - p.timestamp > config.maxSyncAgeMs) return 'Transaction too old to synchronize';
    return null;
  }

  async function validateAcceptance(p: Payment, a: NonNullable<SubmittedTransaction['acceptance']>): Promise<string | null> {
    if (a.transaction_id !== p.transaction_id || a.payer_id !== p.payer_id || a.recipient_id !== p.recipient_id || a.amount !== p.amount || a.currency !== p.currency || a.reference !== p.reference)
      return 'acceptance does not match the payment';
    const cert = a.certificate;
    if (!protocol.verifyCertificate(cert, config.serverPublicKey, a.accepted_at, skew)) return 'invalid or expired receiver certificate';
    if (cert.aid !== p.recipient_id) return 'receiver certificate does not match the payment';
    if (!(await repo.hasCertificate(cert.aid, cert.pk))) return 'receiver certificate was not issued by this backend';
    if (!protocol.verifyAcceptance(a, cert.pk)) return 'invalid receiver signature';
    // the receiver can only have accepted while the payment QR was valid
    if (a.accepted_at < p.timestamp - skew || a.accepted_at > p.expires_at + skew) return 'accepted outside the payment QR validity period';
    return null;
  }

  /* ---------------------------------------------------------------- dependencies */
  /** Dependencies (funding refs / incoming tx IDs) that are not yet applied to the sender's mirror. */
  async function pendingDependencies(doc: StoredTx): Promise<string[]> {
    const waiting: string[] = [];
    for (const dep of doc.dependencies) {
      const key = dep.startsWith('FND-') ? `FUND:${dep}` : `TX:${dep}:CREDIT`;
      if (!(await repo.hasLedgerEntry(doc.payer_id, key))) waiting.push(dep);
    }
    return waiting;
  }

  /* ---------------------------------------------------------------- refund */
  /**
   * One refund per transaction (reference RFD-<transaction_id>, also the unique ledger key).
   * Evidence that the receiver was NOT credited: the payment QR has expired AND the receiver has since completed a
   * full synchronization (everything that device had pending was uploaded) without a record of this transaction.
   */
  async function tryRefund(doc: StoredTx): Promise<string[]> {
    if (doc.state !== 'UNRESOLVED' || !doc.debit_applied || doc.credit_applied || doc.acceptance) return [];
    const n = now();
    if (n <= doc.expires_at + skew) return [];
    const last = await repo.getLastCompleteSync(doc.recipient_id);
    if (last === null || last <= doc.expires_at + skew) return []; // not enough evidence yet

    const reference = `RFD-${doc.transaction_id}`;
    const existing = await repo.getRefund(reference);
    const refund: RefundRecord = existing || { reference, transaction_id: doc.transaction_id, sender_id: doc.payer_id, amount: doc.amount, refunded_at: n };
    await repo.applyLedgerEntry({ key: `REFUND:${reference}`, userId: doc.payer_id, type: 'REFUND', source: 'REFUND', reference, amount: doc.amount, at: n });
    if (!existing) await repo.saveRefund(refund);
    doc.state = 'REFUNDED';
    doc.refund = refund;
    doc.reason = 'Receiver was not credited – payment QR expired unscanned';
    await save(doc);
    return [doc.payer_id];
  }

  /* ---------------------------------------------------------------- state machine */
  /** Applies whatever can be applied. Caller holds the per-transaction lock. Returns users whose mirror balance grew. */
  async function advance(doc: StoredTx): Promise<string[]> {
    const credited: string[] = [];
    if (FINAL.includes(doc.state)) return credited;

    if (!doc.debit_applied) {
      const r = await repo.applyLedgerEntry({
        key: `TX:${doc.transaction_id}:DEBIT`, userId: doc.payer_id, type: 'DEBIT', source: 'TRANSFER', reference: doc.transaction_id, amount: doc.amount, at: now(),
      });
      if (r.applied || r.duplicate) doc.debit_applied = true;
      else {
        const waiting = await pendingDependencies(doc);
        if (waiting.length > 0 || !doc.payer_submitted) {
          doc.state = 'DEFERRED';
          doc.reason = waiting.length > 0 ? 'Waiting for the earlier transactions this payment depends on to synchronize' : 'Waiting for the sender to synchronize';
        } else {
          doc.state = 'REJECTED';
          doc.reason = 'Insufficient mirror wallet balance for the sender';
        }
        await save(doc);
        return credited;
      }
    }

    if (doc.acceptance && !doc.credit_applied) {
      await repo.applyLedgerEntry({
        key: `TX:${doc.transaction_id}:CREDIT`, userId: doc.recipient_id, type: 'CREDIT', source: 'TRANSFER', reference: doc.transaction_id, amount: doc.amount, at: now(),
      });
      doc.credit_applied = true;
      credited.push(doc.recipient_id);
    }

    doc.state = doc.credit_applied ? 'CONFIRMED' : 'UNRESOLVED';
    doc.reason = doc.credit_applied ? null : "Awaiting the receiver's record";
    await save(doc);
    if (doc.state === 'UNRESOLVED') credited.push(...(await tryRefund(doc)));
    return credited;
  }

  async function cascade(userIds: string[], depth: number) {
    for (const u of new Set(userIds)) await reevaluateDeferred(u, depth + 1);
  }

  async function reevaluateDeferred(userId: string, depth = 0): Promise<void> {
    if (depth > MAX_CASCADE_DEPTH) return;
    const deferred = await repo.findDeferredByPayer(userId);
    for (const d of deferred) {
      const credited = await mutex.run(d.transaction_id, async () => {
        const fresh = await repo.getTx(d.transaction_id);
        return fresh && fresh.state === 'DEFERRED' ? advance(fresh) : [];
      });
      await cascade(credited, depth);
    }
  }

  async function completeSync(userId: string): Promise<void> {
    await repo.setLastCompleteSync(userId, now());
    const open = await repo.findUnresolvedByRecipient(userId);
    const refunded: string[] = [];
    for (const d of open) {
      refunded.push(
        ...(await mutex.run(d.transaction_id, async () => {
          const fresh = await repo.getTx(d.transaction_id);
          return fresh ? tryRefund(fresh) : [];
        }))
      );
    }
    await cascade(refunded, 0);
  }

  /* ---------------------------------------------------------------- entry point */
  async function handle(user: AuthUser, t: SubmittedTransaction, deviceId: string | null): Promise<{ result: ProcessResult; credited: string[] }> {
    const isPayer = user.id === t.payer_id;
    const payment = protocol.pickPayment(t);
    const fp = protocol.fingerprint(payment);
    const out = (doc: StoredTx, duplicate: boolean, credited: string[] = []) => ({ result: viewFor(doc, user.id, duplicate), credited });
    const reply = (status: TxState, reason: string, duplicate = false) => ({
      result: { transaction_id: t.transaction_id, status, reason, duplicate, processed_at: now(), refund: null } as ProcessResult,
      credited: [] as string[],
    });

    let doc = await repo.getTx(t.transaction_id);
    const existed = !!doc;
    if (doc && doc.fingerprint !== fp) return reply('CONFLICT', 'Transaction ID already used with different details', true);
    if (!isPayer && !t.acceptance) return reply('REJECTED', 'Missing receiver acceptance record');

    if (!doc) {
      const err = await validateEvidence({ ...payment, payer_certificate: t.payer_certificate });
      const base: StoredTx = {
        ...payment, payer_certificate: t.payer_certificate, acceptance: null, dependencies: [], payer_submitted: false, state: 'DEFERRED', reason: null,
        debit_applied: false, credit_applied: false, fingerprint: fp, device_ids: [], refund: null, created_at: now(), updated_at: now(),
      };
      if (err) {
        base.state = 'REJECTED';
        base.reason = err;
        await save(base);
        return out(base, false);
      }
      doc = base;
    }
    if (doc.state === 'REFUNDED' && !isPayer) return out(doc, true);

    if (!FINAL.includes(doc.state)) {
      if (isPayer) {
        doc.payer_submitted = true;
        if (t.dependencies) doc.dependencies = [...new Set(t.dependencies)];
      } else if (!doc.acceptance) {
        const aerr = await validateAcceptance(payment, t.acceptance!);
        if (aerr) return reply('REJECTED', `Invalid acceptance record: ${aerr}`, existed);
        doc.acceptance = t.acceptance!;
      }
      if (deviceId && !doc.device_ids.includes(deviceId)) doc.device_ids.push(deviceId);
      const credited = await advance(doc);
      return out(doc, existed, credited);
    }
    return out(doc, true);
  }

  async function processOne(user: AuthUser, raw: unknown, deviceId: string | null = null): Promise<ProcessResult> {
    const shape = protocol.validateSubmission(raw, config.currency);
    const rawId = raw && typeof raw === 'object' ? ((raw as any).transaction_id as string | undefined) : undefined;
    if (!shape.ok) {
      return { transaction_id: typeof rawId === 'string' ? rawId : null, status: 'REJECTED', reason: `Malformed transaction: ${shape.errors.join('; ')}`, duplicate: false, processed_at: now() };
    }
    const t = raw as SubmittedTransaction;
    if (user.id !== t.payer_id && user.id !== t.recipient_id) {
      return { transaction_id: t.transaction_id, status: 'REJECTED', reason: 'You are not a party to this transaction', duplicate: false, processed_at: now() };
    }
    const { result, credited } = await mutex.run(t.transaction_id, () => handle(user, t, deviceId));
    await cascade(credited, 0); // outside the lock: unblock transactions that were waiting for this credit
    return result;
  }

  return { processOne, completeSync, reevaluateDeferred, viewFor };
}
