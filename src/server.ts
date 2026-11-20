import mongoose from 'mongoose';
import config from './config';
import { createApp } from './app';

async function main() {
  if (!config.serverSecretKey) throw new Error('SERVER_SIGNING_SECRET_KEY is not set. Copy .env.example to .env (demo key) or run: npm run keygen');
  if (config.jwtSecret === 'dev-only-secret-change-me') console.warn('[warn] JWT_SECRET not set – using a development secret.');
  await mongoose.connect(config.mongoUri);
  await mongoose.syncIndexes(); // creates the unique indexes (transaction_id, ledger entry key, funding reference, refund reference…)
  console.log(`[mongo] connected: ${config.mongoUri}`);
  console.log(`[crypto] app verification public key (must equal SERVER_PUBLIC_KEY in mobile/src/config.ts):\n         ${config.serverPublicKey}`);
  createApp().listen(config.port, '0.0.0.0', () => console.log(`[api] Paybow API listening on :${config.port}`));
}

main().catch((e) => {
  console.error('Failed to start:', e.message);
  process.exit(1);
});
