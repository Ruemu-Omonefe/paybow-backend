import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import config from './config';
import { createMongoRepo } from './services/repository.mongo';
import { createTransactionService } from './services/transactionService';
import { createFundingService, FundingError } from './services/fundingService';
import { authRequired } from './middleware/auth';
import authRoutes from './routes/auth';
import walletRoutes from './routes/wallet';
import fundingRoutes from './routes/funding';
import transactionRoutes from './routes/transactions';
import syncRoutes from './routes/sync';

export function createApp() {
  const app = express();
  const repo = createMongoRepo({ useTransactions: config.useTransactions });
  const txService = createTransactionService(repo, config);
  const fundingService = createFundingService(repo, config, (userId) => txService.reevaluateDeferred(userId));

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  // `server_public_key` is for information/setup only: apps must use the key EMBEDDED at build time, never one fetched at runtime.
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'paybow-api', time: Date.now(), server_public_key: config.serverPublicKey }));

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false });
  app.use('/api/auth', authLimiter, authRoutes);

  app.use('/api/wallet', authRequired, walletRoutes());
  app.use('/api/funding', authRequired, fundingRoutes(fundingService));
  app.use('/api/transactions', authRequired, transactionRoutes(txService));
  app.use('/api/sync', authRequired, syncRoutes(txService, fundingService, repo));

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof FundingError) return res.status(err.status).json({ error: err.message });
    const status: number = err.status || 500;
    if (status >= 500) console.error('[error]', err.message); // never log tokens / secrets
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    res.status(status).json({ error: status >= 500 && status !== 503 ? 'Internal server error' : err.message });
  });
  return app;
}
