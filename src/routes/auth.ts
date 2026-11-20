import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import config from '../config';
import { User, Wallet, CertificateModel } from '../models';
import { signToken, authRequired, AuthedRequest, claimDeviceSession, getDeviceId } from '../middleware/auth';
import { isValidPublicKey, issueCertificate } from '../lib/protocol';

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIN_RE = /^\d{4,6}$/;
const paymentPinVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment PIN attempts. Try again later.' },
});

const userView = (u: any) => ({
  id: String(u._id),
  name: u.name,
  email: u.email,
  wallet_id: u.walletId,
  public_key: u.publicKey,
  has_payment_pin: Boolean(u.paymentPinHash),
});

async function newWalletId(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const id = `PBW${crypto.randomInt(100_000_000, 999_999_999)}`;
    if (!(await User.exists({ walletId: id }))) return id;
  }
  throw new Error('Could not allocate wallet ID');
}

/** Associates the device public key with the account and issues a backend-signed certificate. */
async function issueFor(user: any, publicKey: string) {
  const cert = issueCertificate({ id: String(user._id), name: user.name, walletId: user.walletId }, publicKey, config.serverSecretKey, Date.now(), config.certValidityMs);
  await CertificateModel.create({ ...cert });
  if (user.publicKey !== publicKey) {
    user.publicKey = publicKey;
    await user.save();
  }
  return cert;
}

/** POST /api/auth/register  { name, email, password } → account + unique wallet ID + mirror wallet at ₦0 */
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, payment_pin } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 60) return res.status(400).json({ error: 'Name must be 2-60 characters' });
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email required' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (payment_pin !== undefined && (typeof payment_pin !== 'string' || !PIN_RE.test(payment_pin))) return res.status(400).json({ error: 'Payment PIN must be 4-6 digits' });
    if (await User.exists({ email: email.toLowerCase() })) return res.status(409).json({ error: 'An account with this email already exists' });

    const user = await User.create({
      name: name.trim(),
      email,
      passwordHash: await bcrypt.hash(password, 10),
      paymentPinHash: typeof payment_pin === 'string' ? await bcrypt.hash(payment_pin, 12) : null,
      walletId: await newWalletId(),
    });
    const wallet = await Wallet.create({ userId: user._id, walletId: user.walletId, balance: 0, currency: config.currency });
    res.status(201).json({ user: userView(user), wallet: { wallet_id: wallet.walletId, balance: wallet.balance, currency: wallet.currency } });
  } catch (e: any) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'An account with this email already exists' });
    next(e);
  }
});

/** POST /api/auth/login  { email, password, public_key? } → token (+ signed certificate when a public key is submitted) */
router.post('/login', async (req, res, next) => {
  try {
    const { email, password, public_key } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Email and password required' });
    const deviceId = getDeviceId(req);
    if (!deviceId) return res.status(400).json({ error: 'Valid device ID required' });
    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+paymentPinHash');
    const ok = user && user.status === 'active' && (await bcrypt.compare(password, user.passwordHash));
    if (!user || !ok) return res.status(401).json({ error: 'Invalid email or password' });

    if (public_key !== undefined && !isValidPublicKey(public_key)) return res.status(400).json({ error: 'public_key must be a base64 Ed25519 key' });
    const sessionId = crypto.randomBytes(32).toString('hex');
    if (!(await claimDeviceSession(user._id, deviceId, sessionId))) {
      return res.status(409).json({ error: 'This account is already signed in on another phone. Please log out on that phone before signing in here.' });
    }

    let certificate = null;
    if (public_key !== undefined) {
      certificate = await issueFor(user, public_key);
    }
    const wallet = await Wallet.findOne({ userId: user._id }).lean();
    res.json({
      token: signToken(user._id, sessionId),
      user: userView(user),
      certificate,
      wallet: { wallet_id: user.walletId, balance: wallet ? wallet.balance : 0, currency: config.currency },
    });
  } catch (e) {
    next(e);
  }
});

/** POST /api/auth/logout – releases this phone's active account session. */
router.post('/logout', authRequired, async (req, res, next) => {
  try {
    const { id } = (req as AuthedRequest).user;
    const deviceId = getDeviceId(req)!;
    await User.updateOne(
      { _id: id, activeDeviceId: deviceId },
      { $set: { activeDeviceId: null, activeSessionId: null } }
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/** POST /api/auth/payment-pin/setup { pin } – links a legacy device PIN to its account once. */
router.post('/payment-pin/setup', authRequired, async (req, res, next) => {
  try {
    const { pin } = req.body || {};
    if (typeof pin !== 'string' || !PIN_RE.test(pin)) return res.status(400).json({ error: 'Payment PIN must be 4-6 digits' });
    const userId = (req as AuthedRequest).user.id;
    const result = await User.updateOne(
      { _id: userId, paymentPinHash: null },
      { $set: { paymentPinHash: await bcrypt.hash(pin, 12) } }
    );
    if (!result.modifiedCount) return res.status(409).json({ error: 'A payment PIN is already linked to this account' });
    res.json({ has_payment_pin: true });
  } catch (e) {
    next(e);
  }
});

/** POST /api/auth/payment-pin/verify { pin } – checks the account PIN before saving it on a new device. */
router.post('/payment-pin/verify', paymentPinVerifyLimiter, authRequired, async (req, res, next) => {
  try {
    const { pin } = req.body || {};
    if (typeof pin !== 'string' || !PIN_RE.test(pin)) return res.status(400).json({ error: 'Payment PIN must be 4-6 digits' });
    const user = await User.findById((req as AuthedRequest).user.id).select('+paymentPinHash');
    if (!user?.paymentPinHash) return res.status(409).json({ error: 'No payment PIN is linked to this account yet' });
    res.json({ valid: await bcrypt.compare(pin, user.paymentPinHash) });
  } catch (e) {
    next(e);
  }
});

/** POST /api/auth/certificate  { public_key } – (re)issue a certificate, e.g. before the old one expires. */
router.post('/certificate', authRequired, async (req, res, next) => {
  try {
    const { public_key } = req.body || {};
    if (!isValidPublicKey(public_key)) return res.status(400).json({ error: 'public_key must be a base64 Ed25519 key' });
    const user = await User.findById((req as AuthedRequest).user.id);
    if (!user) return res.status(401).json({ error: 'Account unavailable' });
    res.json({ certificate: await issueFor(user, public_key) });
  } catch (e) {
    next(e);
  }
});

/** GET /api/auth/me */
router.get('/me', authRequired, async (req, res, next) => {
  try {
    const user = await User.findById((req as AuthedRequest).user.id).select('+paymentPinHash');
    res.json({ user: userView(user) });
  } catch (e) {
    next(e);
  }
});

export default router;
