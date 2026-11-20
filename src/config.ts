import dotenv from 'dotenv';
import nacl from 'tweetnacl';
import type { Config } from './types';

dotenv.config();

const num = (v: string | undefined, d: number): number => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

const secret = process.env.SERVER_SIGNING_SECRET_KEY || '';
let publicKey = '';
if (secret) {
  const bytes = Buffer.from(secret, 'base64');
  if (bytes.length !== 64) throw new Error('SERVER_SIGNING_SECRET_KEY must be a base64 Ed25519 secret key (64 bytes). Run: npm run keygen');
  publicKey = Buffer.from(nacl.sign.keyPair.fromSecretKey(new Uint8Array(bytes)).publicKey).toString('base64');
}

const config: Config = {
  port: num(process.env.PORT, 4000),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/paybow',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  serverSecretKey: secret,
  serverPublicKey: publicKey,
  certValidityMs: num(process.env.CERT_VALIDITY_DAYS, 30) * 24 * 60 * 60 * 1000,
  minAmount: num(process.env.MIN_AMOUNT_KOBO, 10_000), // ₦100
  maxAmount: num(process.env.MAX_AMOUNT_KOBO, 50_000_000),
  minFunding: num(process.env.MIN_FUNDING_KOBO, 10_000),
  maxFunding: num(process.env.MAX_FUNDING_KOBO, 50_000_000),
  maxQrWindowMs: num(process.env.MAX_QR_WINDOW_MS, 10 * 60 * 1000),
  maxSyncAgeMs: num(process.env.MAX_SYNC_AGE_MS, 7 * 24 * 60 * 60 * 1000),
  clockSkewMs: num(process.env.CLOCK_SKEW_MS, 2 * 60 * 1000),
  useTransactions: String(process.env.USE_MONGO_TRANSACTIONS).toLowerCase() === 'true',
  fundingProvider: 'simulated',
  currency: 'NGN',
};

export default config;
