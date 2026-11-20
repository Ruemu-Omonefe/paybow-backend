/** In-memory implementation of Repo – lets the service logic be tested without MongoDB. */
import type { FundingRecord, LedgerInput, LedgerResult, RefundRecord, Repo, RepoUser, StoredTx } from '../src/types';

export interface MemoryRepo extends Repo {
  _balances: Map<string, number>;
  _ledger: Map<string, LedgerInput>;
  _txs: Map<string, StoredTx>;
  addUser(u: RepoUser): void;
  addCertificate(accountId: string, publicKey: string): void;
}

export function createMemoryRepo(): MemoryRepo {
  const users = new Map<string, RepoUser>();
  const certs = new Set<string>();
  const balances = new Map<string, number>();
  const ledger = new Map<string, LedgerInput>();
  const txs = new Map<string, StoredTx>();
  const fundings = new Map<string, FundingRecord>();
  const refunds = new Map<string, RefundRecord>();
  const syncs = new Map<string, number>();
  const tick = () => new Promise<void>((r) => setImmediate(r)); // force interleaving like real I/O
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

  return {
    _balances: balances, _ledger: ledger, _txs: txs,
    addUser(u) { users.set(u.id, u); balances.set(u.id, 0); },
    addCertificate(aid, pk) { certs.add(`${aid}|${pk}`); },
    async findUser(id) { await tick(); return users.get(id) || null; },
    async hasCertificate(aid, pk) { return certs.has(`${aid}|${pk}`); },
    async getBalance(id) { return balances.get(id) || 0; },
    async hasLedgerEntry(userId, key) { const e = ledger.get(key); return !!e && e.userId === userId; },
    async applyLedgerEntry(e): Promise<LedgerResult> {
      await tick();
      const bal = balances.get(e.userId) || 0;
      if (ledger.has(e.key)) return { applied: false, duplicate: true, insufficient: false, balance: bal };
      if (e.type === 'DEBIT') {
        if (bal < e.amount) return { applied: false, duplicate: false, insufficient: true, balance: bal };
        balances.set(e.userId, bal - e.amount);
      } else balances.set(e.userId, bal + e.amount);
      ledger.set(e.key, e);
      return { applied: true, duplicate: false, insufficient: false, balance: balances.get(e.userId)! };
    },
    async getTx(id) { const t = txs.get(id); return t ? clone(t) : null; },
    async saveTx(doc) { txs.set(doc.transaction_id, clone(doc)); },
    async findDeferredByPayer(id) { return [...txs.values()].filter((t) => t.payer_id === id && t.state === 'DEFERRED').map(clone); },
    async findUnresolvedByRecipient(id) { return [...txs.values()].filter((t) => t.recipient_id === id && t.state === 'UNRESOLVED').map(clone); },
    async getFunding(ref) { const f = fundings.get(ref); return f ? clone(f) : null; },
    async saveFunding(rec) { fundings.set(rec.reference, clone(rec)); },
    async getRefund(ref) { return refunds.get(ref) || null; },
    async saveRefund(rec) { refunds.set(rec.reference, rec); },
    async getLastCompleteSync(id) { return syncs.get(id) ?? null; },
    async setLastCompleteSync(id, at) { syncs.set(id, at); },
  };
}
