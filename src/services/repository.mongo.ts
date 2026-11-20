import mongoose from 'mongoose';
import { User, Wallet, CertificateModel, LedgerEntry, FundingModel, Transaction, RefundModel, SyncState } from '../models';
import type { FundingRecord, LedgerInput, LedgerResult, RefundRecord, Repo, RepoUser, StoredTx } from '../types';

const strip = <T>(doc: any): T => {
  if (!doc) return doc;
  const { _id, __v, ...rest } = doc;
  return rest as T;
};

export function createMongoRepo({ useTransactions = false }: { useTransactions?: boolean } = {}): Repo {
  return {
    async findUser(id: string): Promise<RepoUser | null> {
      if (!mongoose.isValidObjectId(id)) return null;
      const u = await User.findById(id).lean();
      return u ? { id: String(u._id), name: u.name, email: u.email, walletId: u.walletId, publicKey: u.publicKey ?? null, status: u.status as string } : null;
    },

    async hasCertificate(accountId, publicKey) {
      return !!(await CertificateModel.exists({ aid: accountId, pk: publicKey }));
    },

    async getBalance(userId) {
      const w = await Wallet.findOne({ userId }).lean();
      return w ? w.balance : 0;
    },

    async hasLedgerEntry(userId, key) {
      return !!(await LedgerEntry.exists({ entry_key: key, user_id: userId }));
    },

    /**
     * Ledger entry + mirror wallet change, at most once per `key` (unique index).
     *  - useTransactions=true : one MongoDB multi-document transaction (needs a replica set).
     *  - useTransactions=false: conditional atomic wallet update, then the ledger insert; if the insert loses a race
     *                           (duplicate key) the wallet change is compensated, so the net effect is still once.
     */
    async applyLedgerEntry(e: LedgerInput): Promise<LedgerResult> {
      const delta = e.type === 'DEBIT' ? -e.amount : e.amount;
      const walletFilter: Record<string, unknown> = { userId: e.userId };
      if (e.type === 'DEBIT') walletFilter.balance = { $gte: e.amount };
      const entryDoc = (balance: number) => ({ entry_key: e.key, user_id: e.userId, type: e.type, source: e.source, reference: e.reference, amount: e.amount, balance_after: balance, at: e.at });
      const current = async () => (await Wallet.findOne({ userId: e.userId }).lean())?.balance ?? 0;

      if (await LedgerEntry.exists({ entry_key: e.key })) return { applied: false, duplicate: true, insufficient: false, balance: await current() };

      if (useTransactions) {
        const session = await mongoose.startSession();
        try {
          let out: LedgerResult = { applied: false, duplicate: false, insufficient: false, balance: 0 };
          await session.withTransaction(async () => {
            const w = await Wallet.findOneAndUpdate(walletFilter, { $inc: { balance: delta }, $set: { updatedAt: new Date() } }, { session, new: true });
            if (!w) {
              out = { applied: false, duplicate: false, insufficient: e.type === 'DEBIT', balance: 0 };
              if (e.type !== 'DEBIT') throw new Error('Wallet missing');
              return;
            }
            await LedgerEntry.create([entryDoc(w.balance)], { session });
            out = { applied: true, duplicate: false, insufficient: false, balance: w.balance };
          });
          return out;
        } catch (err: any) {
          if (err && err.code === 11000) return { applied: false, duplicate: true, insufficient: false, balance: await current() };
          throw err;
        } finally {
          await session.endSession();
        }
      }

      const w = await Wallet.findOneAndUpdate(walletFilter, { $inc: { balance: delta }, $set: { updatedAt: new Date() } }, { new: true });
      if (!w) {
        if (e.type === 'DEBIT') return { applied: false, duplicate: false, insufficient: true, balance: await current() };
        throw new Error('Wallet missing');
      }
      try {
        await LedgerEntry.create(entryDoc(w.balance));
        return { applied: true, duplicate: false, insufficient: false, balance: w.balance };
      } catch (err: any) {
        await Wallet.updateOne({ userId: e.userId }, { $inc: { balance: -delta } }); // compensate
        if (err && err.code === 11000) return { applied: false, duplicate: true, insufficient: false, balance: await current() };
        throw err;
      }
    },

    async getTx(id) {
      return strip<StoredTx>(await Transaction.findOne({ transaction_id: id }).lean());
    },
    async saveTx(doc) {
      await Transaction.replaceOne({ transaction_id: doc.transaction_id }, doc, { upsert: true });
    },
    async findDeferredByPayer(payerId) {
      return (await Transaction.find({ payer_id: payerId, state: 'DEFERRED' }).sort({ timestamp: 1 }).lean()).map((d) => strip<StoredTx>(d));
    },
    async findUnresolvedByRecipient(recipientId) {
      return (await Transaction.find({ recipient_id: recipientId, state: 'UNRESOLVED' }).lean()).map((d) => strip<StoredTx>(d));
    },

    async getFunding(reference) {
      return strip<FundingRecord>(await FundingModel.findOne({ reference }).lean());
    },
    async saveFunding(rec) {
      await FundingModel.replaceOne({ reference: rec.reference }, rec, { upsert: true });
    },

    async getRefund(reference) {
      return strip<RefundRecord>(await RefundModel.findOne({ reference }).lean());
    },
    async saveRefund(rec) {
      await RefundModel.replaceOne({ reference: rec.reference }, rec, { upsert: true });
    },

    async getLastCompleteSync(userId) {
      const s = await SyncState.findOne({ user_id: userId }).lean();
      return s ? s.last_complete_sync_at ?? null : null;
    },
    async setLastCompleteSync(userId, at) {
      await SyncState.updateOne({ user_id: userId }, { $set: { last_complete_sync_at: at } }, { upsert: true });
    },
  };
}
