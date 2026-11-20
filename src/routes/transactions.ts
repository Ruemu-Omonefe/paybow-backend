import express from 'express';
import { Transaction } from '../models';
import type { AuthedRequest } from '../middleware/auth';
import type { TransactionService } from '../services/transactionService';
import type { StoredTx } from '../types';

const HTTP_BY_STATUS: Record<string, number> = { CONFIRMED: 201, REJECTED: 422, CONFLICT: 409, UNRESOLVED: 202, DEFERRED: 202, REFUNDED: 200 };

export default function transactionRoutes(service: TransactionService) {
  const router = express.Router();

  const view = (d: StoredTx, me: string) => {
    const v = service.viewFor(d, me);
    return {
      transaction_id: d.transaction_id, payer_id: d.payer_id, payer_name: d.payer_name, recipient_id: d.recipient_id, amount: d.amount, currency: d.currency,
      timestamp: d.timestamp, expires_at: d.expires_at, status: v.status, reason: v.reason, refund: v.refund, processed_at: v.processed_at,
      direction: d.payer_id === me ? 'OUT' : 'IN',
    };
  };

  /** POST /api/transactions – submit ONE transaction record (idempotent on transaction_id). */
  router.post('/', async (req, res, next) => {
    try {
      const result = await service.processOne((req as AuthedRequest).user, req.body, req.get('x-device-id'));
      res.status(result.duplicate ? 200 : HTTP_BY_STATUS[result.status] || 200).json(result);
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/transactions?limit=50 – the authenticated user's own transactions with their backend status. */
  router.get('/', async (req, res, next) => {
    try {
      const me = (req as AuthedRequest).user.id;
      const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 100, 1), 300);
      const docs = (await Transaction.find({ $or: [{ payer_id: me }, { recipient_id: me }] }).sort({ updated_at: -1 }).limit(limit).lean()) as unknown as StoredTx[];
      res.json({ transactions: docs.map((d) => view(d, me)) });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/transactions/:id – one transaction (parties only). */
  router.get('/:id', async (req, res, next) => {
    try {
      const me = (req as AuthedRequest).user.id;
      const d = (await Transaction.findOne({ transaction_id: req.params.id }).lean()) as unknown as StoredTx | null;
      if (!d || (d.payer_id !== me && d.recipient_id !== me)) return res.status(404).json({ error: 'Transaction not found' });
      res.json(view(d, me));
    } catch (e) {
      next(e);
    }
  });

  return router;
}
