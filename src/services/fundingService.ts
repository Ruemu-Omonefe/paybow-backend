/**
 * Wallet funding (prototype: simulated payment provider; a real gateway such as Paystack plugs in behind
 * the PaymentProvider interface).
 *
 *  1. initiate  -> funding record INITIATED with a unique reference
 *  2. provider processes the payment (simulated: POST /funding/simulate marks it PAID)
 *  3. verify    -> backend verifies the reference with the provider, marks it VERIFIED and returns a signed confirmation
 *  4. the app credits its LOCAL wallet and later submits the funding reference during synchronization
 *  5. sync      -> backend re-checks the reference and credits the MIRROR wallet once (unique ledger key FUND:<ref>)
 */
import crypto from 'crypto';
import { fundingPayload, signPayload } from '../lib/protocol';
import { KeyedMutex } from '../lib/mutex';
import type { AuthUser, Config, FundingConfirmation, FundingRecord, FundingSyncResult, Repo } from '../types';

export interface PaymentProvider {
  readonly name: string;
  /** Returns whether the provider reports the payment for this record as successful. */
  verify(record: FundingRecord): Promise<'PAID' | 'PENDING' | 'FAILED'>;
}

/** Simulated provider: the "gateway" has processed the payment once the record reached PAID. */
export const simulatedProvider: PaymentProvider = {
  name: 'simulated',
  async verify(record) {
    return record.status === 'PAID' || record.status === 'VERIFIED' ? 'PAID' : 'PENDING';
  },
};

export class FundingError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Cfg = Pick<Config, 'currency' | 'minFunding' | 'maxFunding' | 'serverSecretKey'>;

export interface FundingService {
  initiate(user: AuthUser, amount: unknown): Promise<FundingRecord>;
  simulatePayment(user: AuthUser, reference: unknown): Promise<FundingRecord>;
  verify(user: AuthUser, reference: unknown): Promise<FundingConfirmation>;
  applyOnSync(user: AuthUser, item: unknown): Promise<FundingSyncResult>;
}

export function createFundingService(
  repo: Repo,
  config: Cfg,
  onMirrorCredited: (userId: string) => Promise<void>,
  provider: PaymentProvider = simulatedProvider,
  now: () => number = () => Date.now()
): FundingService {
  const mutex = new KeyedMutex();
  const REF = /^FND-[0-9a-f]{16}$/;

  async function owned(user: AuthUser, reference: unknown): Promise<FundingRecord> {
    if (typeof reference !== 'string' || !REF.test(reference)) throw new FundingError(400, 'Invalid funding reference');
    const rec = await repo.getFunding(reference);
    if (!rec || rec.user_id !== user.id) throw new FundingError(404, 'Funding reference not found');
    return rec;
  }

  const confirmationOf = (r: FundingRecord): FundingConfirmation => ({
    reference: r.reference, account_id: r.user_id, amount: r.amount, currency: r.currency, status: 'VERIFIED', verified_at: r.verified_at!, signature: r.confirmation_signature!,
  });

  return {
    async initiate(user, amount) {
      if (!Number.isSafeInteger(amount) || (amount as number) < config.minFunding || (amount as number) > config.maxFunding)
        throw new FundingError(400, `Amount must be between ${config.minFunding} and ${config.maxFunding} kobo`);
      const rec: FundingRecord = {
        reference: `FND-${crypto.randomBytes(8).toString('hex')}`, user_id: user.id, amount: amount as number, currency: config.currency, provider: provider.name,
        status: 'INITIATED', verified_at: null, confirmation_signature: null, applied: false, created_at: now(),
      };
      await repo.saveFunding(rec);
      return rec;
    },

    async simulatePayment(user, reference) {
      const rec = await owned(user, reference);
      if (provider.name !== 'simulated') throw new FundingError(400, 'Simulated payments are disabled');
      if (rec.status === 'INITIATED') {
        rec.status = 'PAID';
        await repo.saveFunding(rec);
      }
      return rec;
    },

    /** Backend verifies the payment reference with the provider; idempotent (same confirmation every time). */
    async verify(user, reference) {
      const rec0 = await owned(user, reference);
      return mutex.run(rec0.reference, async () => {
        const rec = (await repo.getFunding(rec0.reference))!;
        if (rec.status === 'VERIFIED') return confirmationOf(rec);
        const outcome = await provider.verify(rec);
        if (outcome === 'FAILED') {
          rec.status = 'FAILED';
          await repo.saveFunding(rec);
          throw new FundingError(402, 'Payment failed');
        }
        if (outcome !== 'PAID') throw new FundingError(409, 'Payment not completed yet');
        rec.status = 'VERIFIED';
        rec.verified_at = now();
        rec.confirmation_signature = signPayload(
          fundingPayload({ reference: rec.reference, account_id: rec.user_id, amount: rec.amount, currency: rec.currency, verified_at: rec.verified_at }),
          config.serverSecretKey
        );
        await repo.saveFunding(rec);
        return confirmationOf(rec);
      });
    },

    /** Synchronization step: credit the mirror wallet once for a VERIFIED funding reference. */
    async applyOnSync(user, item) {
      const reference = item && typeof item === 'object' ? (item as any).reference : null;
      const fail = (reason: string): FundingSyncResult => ({ reference: typeof reference === 'string' ? reference : null, status: 'REJECTED', reason, duplicate: false });
      if (typeof reference !== 'string' || !REF.test(reference)) return fail('Invalid funding reference');
      const outcome = await mutex.run(reference, async (): Promise<FundingSyncResult> => {
        const rec = await repo.getFunding(reference);
        if (!rec || rec.user_id !== user.id) return fail('Funding reference not found');
        if (rec.status !== 'VERIFIED') return fail('Funding reference has no verified payment');
        if ((item as any).amount !== rec.amount) return fail('Funding amount does not match the verified payment');
        const r = await repo.applyLedgerEntry({ key: `FUND:${reference}`, userId: user.id, type: 'CREDIT', source: 'FUNDING', reference, amount: rec.amount, at: now() });
        if (!rec.applied) {
          rec.applied = true;
          await repo.saveFunding(rec);
        }
        return { reference, status: 'CONFIRMED', reason: null, duplicate: r.duplicate };
      });
      if (outcome.status === 'CONFIRMED' && !outcome.duplicate) await onMirrorCredited(user.id); // may unblock deferred spends
      return outcome;
    },
  };
}
