import mongoose, { Schema } from 'mongoose';

/** users: account, authentication info, wallet ID, current public key, status */
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    paymentPinHash: { type: String, default: null, select: false },
    activeDeviceId: { type: String, default: null, select: false },
    activeSessionId: { type: String, default: null, select: false },
    walletId: { type: String, required: true, unique: true },
    publicKey: { type: String, default: null }, // current device public key (base64 Ed25519)
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  },
  { timestamps: true }
);

/** wallets: the MIRROR of the user's local wallet (not independently spendable). Integer kobo. Starts at 0. */
const walletSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    walletId: { type: String, required: true, unique: true },
    balance: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, default: 'NGN' },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

/** certificates: every public-key certificate issued (key history per account) */
const certificateSchema = new Schema(
  {
    sn: { type: String, required: true, unique: true },
    aid: { type: String, required: true, index: true },
    nm: String, wid: String, pk: { type: String, required: true }, iat: Number, exp: Number, sig: String,
  },
  { timestamps: true, versionKey: false }
);
certificateSchema.index({ aid: 1, pk: 1 });

/** ledger_entries: verified entries that changed the mirror wallet. `entry_key` is unique => applied once. */
const ledgerSchema = new Schema(
  {
    entry_key: { type: String, required: true, unique: true },
    user_id: { type: String, required: true, index: true },
    type: { type: String, enum: ['CREDIT', 'DEBIT', 'REFUND'], required: true },
    source: { type: String, enum: ['FUNDING', 'TRANSFER', 'REFUND'], required: true },
    reference: { type: String, required: true },
    amount: { type: Number, required: true },
    balance_after: { type: Number, required: true },
    at: { type: Number, required: true },
  },
  { versionKey: false }
);

/** funding_records: funding references and their verified payment status */
const fundingSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    user_id: { type: String, required: true, index: true },
    amount: Number, currency: String, provider: String,
    status: { type: String, enum: ['INITIATED', 'PAID', 'VERIFIED', 'FAILED'], required: true },
    verified_at: { type: Number, default: null },
    confirmation_signature: { type: String, default: null },
    applied: { type: Boolean, default: false },
    created_at: Number,
  },
  { versionKey: false }
);

/**
 * transactions: unique transaction_id (the idempotency guard; `fingerprint` detects same-ID/different-details),
 * both parties' evidence (sender signature + certificate, receiver acceptance record), state and reason.
 */
const transactionSchema = new Schema(
  {
    transaction_id: { type: String, required: true, unique: true },
    payer_id: { type: String, required: true, index: true },
    payer_name: String,
    recipient_id: { type: String, required: true, index: true },
    amount: Number, currency: String, timestamp: Number, expires_at: Number, reference: String, signature: String,
    payer_certificate: Schema.Types.Mixed,
    acceptance: { type: Schema.Types.Mixed, default: null },
    dependencies: { type: [String], default: [] },
    payer_submitted: { type: Boolean, default: false },
    state: { type: String, enum: ['UNRESOLVED', 'DEFERRED', 'CONFIRMED', 'REJECTED', 'CONFLICT', 'REFUNDED'], required: true },
    reason: { type: String, default: null },
    debit_applied: { type: Boolean, default: false },
    credit_applied: { type: Boolean, default: false },
    fingerprint: String,
    device_ids: { type: [String], default: [] },
    refund: { type: Schema.Types.Mixed, default: null },
    created_at: Number,
    updated_at: Number,
  },
  { versionKey: false }
);
transactionSchema.index({ payer_id: 1, state: 1 });
transactionSchema.index({ recipient_id: 1, state: 1 });

/** refunds: unique refund reference, transaction identifier, sender, amount and timestamp */
const refundSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    transaction_id: { type: String, required: true, unique: true },
    sender_id: String, amount: Number, refunded_at: Number,
  },
  { versionKey: false }
);

/** sync_state: last COMPLETE synchronization of each user's device (evidence for refunds) */
const syncStateSchema = new Schema({ user_id: { type: String, required: true, unique: true }, last_complete_sync_at: Number }, { versionKey: false });

export const User = mongoose.model('User', userSchema);
export const Wallet = mongoose.model('Wallet', walletSchema);
export const CertificateModel = mongoose.model('Certificate', certificateSchema);
export const LedgerEntry = mongoose.model('LedgerEntry', ledgerSchema);
export const FundingModel = mongoose.model('FundingRecord', fundingSchema);
export const Transaction = mongoose.model('Transaction', transactionSchema);
export const RefundModel = mongoose.model('Refund', refundSchema);
export const SyncState = mongoose.model('SyncState', syncStateSchema);
