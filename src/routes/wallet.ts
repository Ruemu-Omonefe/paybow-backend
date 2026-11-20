import express from 'express';
import config from '../config';
import { Wallet, LedgerEntry } from '../models';
import type { AuthedRequest } from '../middleware/auth';

/** GET /api/wallet – the user's MIRROR wallet (last synchronized balance; the device wallet is the spendable one). */
export default function walletRoutes() {
  const router = express.Router();
  router.get('/', async (req, res, next) => {
    try {
      const w = await Wallet.findOne({ userId: (req as AuthedRequest).user.id }).lean();
      if (!w) return res.status(404).json({ error: 'Wallet not found' });
      res.json({ wallet_id: w.walletId, balance: w.balance, currency: config.currency, updated_at: w.updatedAt });
    } catch (e) {
      next(e);
    }
  });

  /** GET /api/wallet/ledger – verified ledger entries that built the mirror balance. */
  router.get('/ledger', async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 50, 1), 200);
      const entries = await LedgerEntry.find({ user_id: (req as AuthedRequest).user.id }).sort({ at: -1 }).limit(limit).lean();
      res.json({ entries: entries.map(({ _id, ...e }) => e) });
    } catch (e) {
      next(e);
    }
  });
  return router;
}
