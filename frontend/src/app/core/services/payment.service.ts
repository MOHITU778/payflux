import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import {
  AnalyticsOverview, FraudAlert, LedgerEntry, Page, Payment, QueryParams, Reconciliation,
  Refund, Settlement, TimeSeries, Transaction, TrialBalance, WebhookDelivery, WebhookEndpoint,
} from '../models';

/**
 * Domain data access.
 *
 * One service per bounded area would be tidier in a larger app; here a single
 * facade keeps the feature components free of URL strings and makes the API
 * surface easy to read in one place.
 */
@Injectable({ providedIn: 'root' })
export class PaymentApiService {
  private readonly api = inject(ApiService);

  // ── Payments ──────────────────────────────────────────────────────────
  listPayments(query: QueryParams): Observable<Page<Payment>> {
    return this.api.getPage<Payment>('/payments', query);
  }

  getPayment(paymentId: string): Observable<Payment> {
    return this.api.get<Payment>(`/payments/${paymentId}`);
  }

  createPayment(body: unknown): Observable<Payment> {
    // A fresh key per user-initiated attempt: a double-click sends the same
    // key and is collapsed server-side into one charge.
    return this.api.post<Payment>('/payments', body, ApiService.newIdempotencyKey());
  }

  verifyPayment(paymentId: string): Observable<Payment> {
    return this.api.post<Payment>(`/payments/${paymentId}/verify`, { reconcile: true });
  }

  cancelPayment(paymentId: string, reason: string): Observable<Payment> {
    return this.api.post<Payment>(
      `/payments/${paymentId}/cancel`, { reason }, ApiService.newIdempotencyKey(),
    );
  }

  refundPayment(paymentId: string, body: { amountMinor?: number; reason?: string; notes?: string })
    : Observable<Refund> {
    return this.api.post<Refund>(
      `/payments/${paymentId}/refunds`, body, ApiService.newIdempotencyKey(),
    );
  }

  listRefunds(query: QueryParams): Observable<Page<Refund>> {
    return this.api.getPage<Refund>('/refunds', query);
  }

  listTransactions(query: QueryParams): Observable<Page<Transaction>> {
    return this.api.getPage<Transaction>('/transactions', query);
  }

  // ── Analytics ─────────────────────────────────────────────────────────
  overview(query: QueryParams): Observable<AnalyticsOverview> {
    return this.api.get<AnalyticsOverview>('/analytics/overview', query);
  }

  timeSeries(query: QueryParams): Observable<TimeSeries> {
    return this.api.get<TimeSeries>('/analytics/timeseries', query);
  }

  // ── Fraud ─────────────────────────────────────────────────────────────
  fraudAlerts(query: QueryParams): Observable<Page<FraudAlert>> {
    return this.api.getPage<FraudAlert>('/fraud/alerts', query);
  }

  fraudAnalytics(query: QueryParams): Observable<{
    breakdown: { _id: string; count: number; avgScore: number }[];
    topRules: { ruleId: string; name: string; hits: number; blocks: number; avgScore: number }[];
    distribution: { from: number; count: number }[];
  }> {
    return this.api.get('/fraud/analytics', query);
  }

  reviewAlert(fraudLogId: string, decision: string, notes: string): Observable<unknown> {
    return this.api.post(`/fraud/alerts/${fraudLogId}/review`, { decision, notes });
  }

  // ── Settlements ───────────────────────────────────────────────────────
  listSettlements(query: QueryParams): Observable<Page<Settlement>> {
    return this.api.getPage<Settlement>('/settlements', query);
  }

  settlementQueue(): Observable<Settlement[]> {
    return this.api.get<Settlement[]>('/settlements/queue');
  }

  runSettlement(merchantId: string, currency?: string): Observable<Settlement | null> {
    return this.api.post<Settlement | null>('/settlements/run', { merchantId, currency });
  }

  // ── Webhooks ──────────────────────────────────────────────────────────
  listEndpoints(): Observable<WebhookEndpoint[]> {
    return this.api.get<WebhookEndpoint[]>('/webhooks/endpoints');
  }

  createEndpoint(body: { url: string; description?: string; subscribedEvents?: string[] })
    : Observable<WebhookEndpoint> {
    return this.api.post<WebhookEndpoint>('/webhooks/endpoints', body);
  }

  updateEndpoint(endpointId: string, body: Partial<WebhookEndpoint>): Observable<WebhookEndpoint> {
    return this.api.patch<WebhookEndpoint>(`/webhooks/endpoints/${endpointId}`, body);
  }

  listDeliveries(query: QueryParams): Observable<Page<WebhookDelivery>> {
    return this.api.getPage<WebhookDelivery>('/webhooks/deliveries', query);
  }

  deadLetterQueue(query: QueryParams): Observable<Page<WebhookDelivery>> {
    return this.api.getPage<WebhookDelivery>('/webhooks/dead-letter', query);
  }

  replayDelivery(deliveryId: string): Observable<{ deliveryId: string; status: string }> {
    return this.api.post(`/webhooks/deliveries/${deliveryId}/replay`, {});
  }

  // ── Ledger ────────────────────────────────────────────────────────────
  balance(currency = 'INR'): Observable<{ code: string; balanceMinor: number; formatted: string }> {
    return this.api.get('/ledger/balance', { currency });
  }

  trialBalance(query: QueryParams): Observable<TrialBalance> {
    return this.api.get<TrialBalance>('/ledger/trial-balance', query);
  }

  entriesFor(type: string, id: string): Observable<LedgerEntry[]> {
    return this.api.get<LedgerEntry[]>(`/ledger/entries/${type}/${id}`);
  }

  reconciliations(query: QueryParams): Observable<Page<Reconciliation>> {
    return this.api.getPage<Reconciliation>('/ledger/reconciliations', query);
  }

  runReconciliation(currency = 'INR'): Observable<Reconciliation> {
    return this.api.post<Reconciliation>('/ledger/reconciliations', { currency });
  }
}
