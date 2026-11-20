import express from 'express';
import type { AuthedRequest } from '../middleware/auth';
import type { TransactionService } from '../services/transactionService';
import type { FundingService } from '../services/fundingService';
import type { Repo } from '../types';

const MAX_BATCH = 50;

/**
 * POST /api/sync  { device_id, funding: [{reference, amount}], transactions: [...], complete: boolean }
 * Funding references are applied first, then incoming (receiver) records, then outgoing (sender) records.
 * Every item gets its own outcome; ERROR means "retry later with the same ID".
 * `complete: true` = the device uploaded EVERYTHING it had pending (evidence used by the refund service).
 */
export default function syncRoutes(service: TransactionService, funding: FundingService, repo: Repo) {
  const router = express.Router();

  router.post('/', async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const { device_id: deviceId, funding: fundingItems = [], transactions = [], complete = false } = req.body || {};
      if (!Array.isArray(fundingItems) || !Array.isArray(transactions)) return res.status(400).json({ error: 'funding and transactions must be arrays' });
      if (fundingItems.length > MAX_BATCH || transactions.length > MAX_BATCH) return res.status(400).json({ error: `Max ${MAX_BATCH} items per list` });
      const device = typeof deviceId === 'string' ? deviceId : null;
      let failed = false;

      const funding_results: unknown[] = [];
      for (const f of fundingItems) {
        try {
          funding_results.push(await funding.applyOnSync(user, f));
        } catch {
          failed = true;
          funding_results.push({ reference: f && f.reference, status: 'ERROR', retryable: true, reason: 'Temporary server error' });
        }
      }

      // causal order: money coming IN is applied before money going OUT, each group oldest first
      const incoming = transactions.filter((t: any) => t && t.recipient_id === user.id);
      const outgoing = transactions.filter((t: any) => !(t && t.recipient_id === user.id));
      const byTime = (a: any, b: any) => (a?.timestamp || 0) - (b?.timestamp || 0);
      const results: unknown[] = [];
      for (const t of [...incoming.sort(byTime), ...outgoing.sort(byTime)]) {
        try {
          results.push(await service.processOne(user, t, device));
        } catch {
          failed = true;
          results.push({ transaction_id: t && t.transaction_id, status: 'ERROR', retryable: true, reason: 'Temporary server error', duplicate: false });
        }
      }

      if (complete === true && !failed) await service.completeSync(user.id);
      res.json({ funding_results, results, balance: await repo.getBalance(user.id), currency: 'NGN', server_time: Date.now() });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
