import express from 'express';
import type { AuthedRequest } from '../middleware/auth';
import { FundingError, FundingService } from '../services/fundingService';

/**
 * Wallet funding (simulated provider in the prototype).
 *   POST /api/funding/initiate  { amount }     → reference
 *   POST /api/funding/simulate  { reference }  → the simulated gateway processes the payment (PAID)
 *   POST /api/funding/verify    { reference }  → backend verifies the payment; returns the signed confirmation
 */
export default function fundingRoutes(funding: FundingService) {
  const router = express.Router();
  const wrap = (fn: (req: express.Request) => Promise<unknown>, status = 200): express.RequestHandler => async (req, res, next) => {
    try {
      res.status(status).json(await fn(req));
    } catch (e) {
      if (e instanceof FundingError) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  };
  const user = (req: express.Request) => (req as AuthedRequest).user;

  router.post('/initiate', wrap(async (req) => ({ funding: await funding.initiate(user(req), req.body?.amount) }), 201));
  router.post('/simulate', wrap(async (req) => ({ funding: await funding.simulatePayment(user(req), req.body?.reference) })));
  router.post('/verify', wrap(async (req) => ({ confirmation: await funding.verify(user(req), req.body?.reference) })));
  return router;
}
