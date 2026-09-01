/**
 * API contract types.
 *
 * These mirror the server's view models exactly. Keeping them in one file makes
 * a server-side shape change a single, visible edit on the client, and
 * `strictTemplates` then surfaces every template that needs updating at build
 * time rather than at runtime.
 */

export type PaymentStatus =
  | 'PENDING' | 'AUTHORIZED' | 'PROCESSING' | 'SUCCESS'
  | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'CANCELLED';

export type RefundStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';
export type SettlementStatus = 'QUEUED' | 'PROCESSING' | 'SETTLED' | 'FAILED';
export type FraudDecision = 'ALLOW' | 'REVIEW' | 'BLOCK';
export type Role = 'ADMIN' | 'MERCHANT' | 'SUPPORT';
export type PaymentMethod = 'CARD' | 'UPI' | 'NETBANKING' | 'WALLET';
export type WebhookStatus = 'PENDING' | 'DELIVERED' | 'RETRYING' | 'FAILED' | 'DEAD_LETTERED';

/** The envelope every endpoint returns. */
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  pagination?: Pagination;
  meta: { timestamp: string; correlationId: string; requestId: string };
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface Pagination {
  total: number;
  page: number;
  limit: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface Page<T> {
  items: T[];
  pagination: Pagination;
}

export interface Merchant {
  merchantId: string;
  name: string;
  status: string;
  defaultCurrency: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  lastLoginAt: string | null;
  merchant: Merchant | null;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: string;
  user: User;
}

export interface StateTransition {
  from: string;
  to: PaymentStatus;
  reason: string | null;
  actor: string;
  at: string;
}

export interface Payment {
  paymentId: string;
  status: PaymentStatus;
  amountMinor: number;
  /** Server-formatted for display, so every client renders money identically. */
  amount: string;
  currency: string;
  feeMinor: number;
  fee: string;
  amountRefundedMinor: number;
  amountRefunded: string;
  refundableMinor: number;
  method: PaymentMethod;
  description: string | null;
  customer: {
    customerId?: string | null;
    email?: string | null;
    contact?: string | null;
    last4?: string | null;
    network?: string | null;
    country?: string | null;
  };
  risk: { score: number; decision: FraudDecision; triggeredRules: string[] };
  acquirer: { referenceId: string | null; authCode: string | null } | null;
  failure: { code: string; message: string; at: string } | null;
  /** Drives which action buttons the UI offers — the server owns this rule. */
  allowedTransitions: PaymentStatus[];
  merchantId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  stateHistory?: StateTransition[];
}

export interface Refund {
  refundId: string;
  paymentId: string;
  status: RefundStatus;
  amountMinor: number;
  amount: string;
  currency: string;
  isFullRefund: boolean;
  reason: string;
  notes: string | null;
  failure: { code: string; message: string } | null;
  createdAt: string;
  processedAt: string | null;
}

export interface Transaction {
  transactionId: string;
  type: 'PAYMENT' | 'REFUND' | 'SETTLEMENT' | 'FEE' | 'CHARGEBACK' | 'ADJUSTMENT';
  direction: 'CREDIT' | 'DEBIT';
  amountMinor: number;
  amountFormatted: string;
  netMinor: number;
  netFormatted: string;
  currency: string;
  status: string;
  description: string | null;
  sourceType: string;
  sourceId: string;
  occurredAt: string;
}

export interface Settlement {
  settlementId: string;
  status: SettlementStatus;
  currency: string;
  grossAmountMinor: number;
  gross: string;
  refundedAmountMinor: number;
  refunded: string;
  feeAmountMinor: number;
  fee: string;
  netAmountMinor: number;
  net: string;
  paymentCount: number;
  periodStart: string;
  periodEnd: string;
  payout: { reference: string | null; bankAccountLast4: string | null; completedAt: string | null };
  failure: { code: string; message: string; attempts: number } | null;
  merchant?: { merchantId: string; name: string };
  createdAt: string;
}

export interface FraudRuleHit {
  ruleId: string;
  ruleName: string;
  weight: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  detail: string | null;
  evidence: unknown;
}

export interface FraudAlert {
  fraudLogId: string;
  paymentId: string | null;
  riskScore: number;
  decision: FraudDecision;
  triggeredRules: FraudRuleHit[];
  signals: {
    amountMinor: number | null;
    currency: string | null;
    ipAddress: string | null;
    ipCountry: string | null;
    customerEmail: string | null;
    velocityCount: number | null;
  };
  evaluationMs: number;
  reviewDecision: FraudDecision | null;
  createdAt: string;
}

export interface WebhookEndpoint {
  endpointId: string;
  url: string;
  description: string | null;
  subscribedEvents: string[];
  isActive: boolean;
  health: {
    consecutiveFailures: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastFailureReason: string | null;
  };
  retrySchedule: number[];
  createdAt: string;
  /** Present only in the create response — shown once, never retrievable again. */
  secret?: string;
}

export interface WebhookDeliveryAttempt {
  attempt: number;
  at: string;
  statusCode: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface WebhookDelivery {
  deliveryId: string;
  eventId: string;
  eventType: string;
  url: string;
  status: WebhookStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  attempts: WebhookDeliveryAttempt[];
  deliveredAt: string | null;
  deadLetteredAt: string | null;
  createdAt: string;
}

export interface AnalyticsOverview {
  range: { from: string; to: string };
  currency: string;
  headline: {
    totalPayments: number;
    succeededPayments: number;
    failedPayments: number;
    successRate: number;
    grossVolumeMinor: number;
    grossVolume: string;
    netRevenueMinor: number;
    netRevenue: string;
    platformFeeMinor: number;
    platformFee: string;
    refundedMinor: number;
    refunded: string;
    averageTicketMinor: number;
  };
  byStatus: { status: PaymentStatus; count: number; amountMinor: number; amount: string }[];
  byMethod: { method: PaymentMethod; count: number; amountMinor: number; amount: string }[];
  topFailureReasons: { _id: string; count: number }[];
  refundsByReason: { reason: string; count: number; amountMinor: number }[];
  settlements: { status: SettlementStatus; count: number; netMinor: number; net: string }[];
  fraud: { decision: FraudDecision; count: number; avgScore: number }[];
  webhooks: { status: WebhookStatus; count: number; avgAttempts: number }[];
  queues: { queue: string; waiting?: number; active?: number; delayed?: number; failed?: number }[];
}

export interface TimeSeriesPoint {
  bucket: string;
  total: number;
  succeeded: number;
  failed: number;
  amountMinor: number;
  amount: string;
}

export interface TimeSeries {
  range: { from: string; to: string };
  unit: string;
  points: TimeSeriesPoint[];
}

export interface LedgerAccount {
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE';
  balanceMinor: number;
  totalDebitMinor: number;
  totalCreditMinor: number;
  entryCount: number;
}

export interface TrialBalance {
  currency: string;
  periodStart: string;
  periodEnd: string;
  totalDebitMinor: number;
  totalCreditMinor: number;
  entryCount: number;
  balanced: boolean;
  accounts: LedgerAccount[];
}

export interface LedgerEntry {
  entryId: string;
  journalId: string;
  accountCode: string;
  entryType: 'DEBIT' | 'CREDIT';
  amountMinor: number;
  currency: string;
  balanceAfterMinor: number;
  sequence: number;
  reference: { type: string; id: string };
  description: string | null;
  postedAt: string;
}

export interface Reconciliation {
  runId: string;
  currency: string;
  periodStart: string;
  periodEnd: string;
  accountsChecked: number;
  entriesChecked: number;
  totalDebitMinor: number;
  totalCreditMinor: number;
  imbalanceMinor: number;
  status: 'BALANCED' | 'DISCREPANCY_FOUND' | 'FAILED';
  discrepancies: {
    kind: string; accountCode: string | null; journalId: string | null;
    expectedMinor: number | null; actualMinor: number | null; deltaMinor: number | null;
    detail: string | null;
  }[];
  durationMs: number;
  createdAt: string;
}

export interface QueryParams {
  [key: string]: string | number | boolean | undefined | null;
}
