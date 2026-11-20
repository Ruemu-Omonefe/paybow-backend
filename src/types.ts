/** Shared backend types. Wire formats mirror mobile/src/lib/protocol.ts. */

/** Backend-side transaction states (the mobile app maps these onto its own statuses). */
export type TxState = 'UNRESOLVED' | 'DEFERRED' | 'CONFIRMED' | 'REJECTED' | 'CONFLICT' | 'REFUNDED';

/** Backend-signed public-key certificate = the user's "identity credential". */
export interface Certificate {
  v: 1;
  sn: string; // serial
  aid: string; // account ID
  nm: string; // registered name
  wid: string; // wallet ID
  pk: string; // base64 Ed25519 public key
  iat: number; // issued at (ms)
  exp: number; // expiry (ms)
  sig: string; // base64 signature by the backend signing key
}

/** Payment information signed by the sender's private key. */
export interface Payment {
  transaction_id: string;
  payer_id: string;
  payer_name: string;
  recipient_id: string;
  amount: number; // integer kobo
  currency: string;
  timestamp: number; // epoch ms
  expires_at: number; // epoch ms (payment QR expiry)
  reference: string; // receiver's identification-QR reference/nonce
  signature: string; // base64
}

/** Receiver's signed acceptance record. */
export interface Acceptance {
  transaction_id: string;
  payer_id: string;
  recipient_id: string;
  amount: number;
  currency: string;
  accepted_at: number;
  reference: string;
  signature: string; // base64, by the receiver's key
  certificate: Certificate; // receiver's certificate
}

/** What a device submits for one payment (either side). */
export interface SubmittedTransaction extends Payment {
  payer_certificate: Certificate;
  acceptance?: Acceptance; // receiver side only
  dependencies?: string[]; // sender side: funding refs / incoming tx IDs that support this spend
}

export interface RefundRecord {
  reference: string; // unique refund reference
  transaction_id: string;
  sender_id: string;
  amount: number;
  refunded_at: number;
}

export interface StoredTx extends Payment {
  payer_certificate: Certificate;
  acceptance: Acceptance | null;
  dependencies: string[];
  payer_submitted: boolean;
  state: TxState;
  reason: string | null;
  debit_applied: boolean;
  credit_applied: boolean;
  fingerprint: string;
  device_ids: string[];
  refund: RefundRecord | null;
  created_at: number;
  updated_at: number;
}

export interface ProcessResult {
  transaction_id: string | null;
  status: TxState;
  reason: string | null;
  duplicate: boolean;
  processed_at: number;
  refund?: RefundRecord | null;
}

export interface FundingRecord {
  reference: string;
  user_id: string;
  amount: number;
  currency: string;
  provider: string;
  status: 'INITIATED' | 'PAID' | 'VERIFIED' | 'FAILED';
  verified_at: number | null;
  confirmation_signature: string | null;
  applied: boolean; // credited to the mirror wallet (happens on sync, once)
  created_at: number;
}

export interface FundingConfirmation {
  reference: string;
  account_id: string;
  amount: number;
  currency: string;
  status: 'VERIFIED';
  verified_at: number;
  signature: string;
}

export interface FundingSyncResult {
  reference: string | null;
  status: 'CONFIRMED' | 'REJECTED';
  reason: string | null;
  duplicate: boolean;
}

export interface AuthUser {
  id: string;
  name: string;
}

export interface RepoUser {
  id: string;
  name: string;
  email?: string;
  walletId: string;
  publicKey: string | null;
  status: string;
}

export interface LedgerInput {
  key: string; // unique idempotency key of the entry, e.g. "TX:<id>:DEBIT"
  userId: string;
  type: 'CREDIT' | 'DEBIT' | 'REFUND';
  source: 'FUNDING' | 'TRANSFER' | 'REFUND';
  reference: string;
  amount: number;
  at: number;
}

export interface LedgerResult {
  applied: boolean;
  duplicate: boolean; // entry with this key already existed -> nothing changed
  insufficient: boolean; // DEBIT refused: mirror balance too low
  balance: number;
}

/** Persistence interface used by the services (Mongo implementation + in-memory test one). */
export interface Repo {
  findUser(id: string): Promise<RepoUser | null>;
  hasCertificate(accountId: string, publicKey: string): Promise<boolean>;
  getBalance(userId: string): Promise<number>;
  hasLedgerEntry(userId: string, key: string): Promise<boolean>;
  /** Applies a ledger entry + wallet change atomically and AT MOST ONCE per key. */
  applyLedgerEntry(e: LedgerInput): Promise<LedgerResult>;
  getTx(id: string): Promise<StoredTx | null>;
  saveTx(doc: StoredTx): Promise<void>;
  findDeferredByPayer(payerId: string): Promise<StoredTx[]>;
  findUnresolvedByRecipient(recipientId: string): Promise<StoredTx[]>;
  getFunding(reference: string): Promise<FundingRecord | null>;
  saveFunding(rec: FundingRecord): Promise<void>;
  getRefund(reference: string): Promise<RefundRecord | null>;
  saveRefund(rec: RefundRecord): Promise<void>;
  getLastCompleteSync(userId: string): Promise<number | null>;
  setLastCompleteSync(userId: string, at: number): Promise<void>;
}

export interface Config {
  port: number;
  mongoUri: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  serverSecretKey: string; // base64 Ed25519 secret key of the backend signing key
  serverPublicKey: string; // base64 – the "embedded verification key" shipped inside the app
  certValidityMs: number;
  minAmount: number;
  maxAmount: number;
  minFunding: number;
  maxFunding: number;
  maxQrWindowMs: number;
  maxSyncAgeMs: number;
  clockSkewMs: number;
  useTransactions: boolean;
  fundingProvider: 'simulated';
  currency: string;
}
