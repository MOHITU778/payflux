import { Component, Input, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { PaymentApiService } from '../../core/services/payment.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { LedgerEntry, Payment } from '../../core/models';
import { StatusBadgeComponent } from '../../shared/components/status-badge.component';

/**
 * Payment detail: state history, risk breakdown, ledger legs and actions.
 *
 * Note: the found and not-found cases are separate blocks rather than an
 * if/else chain, because Angular permits the `as` alias only on a primary
 * `if` block — using it on an `else if` is a compile error (NG5002).
 *
 * Which actions are offered is driven entirely by `allowedTransitions`, which
 * the server computes from the same state machine it enforces. The UI never
 * hard-codes "you can refund a SUCCESS payment" — if the server's rules change,
 * the buttons follow automatically and can never drift out of sync.
 */
@Component({
  selector: 'pf-payment-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, StatusBadgeComponent],
  template: `
    <div class="page">
      <a routerLink="/transactions" class="back tiny">← Back to transactions</a>

      @if (loading()) {
        <div class="card"><div class="skeleton" style="height:120px"></div></div>
      }
      @if (!loading() && !payment()) {
        <div class="card"><div class="empty">Payment not found</div></div>
      }

      @if (payment(); as p) {
        <!-- ── Header ────────────────────────────────────────────── -->
        <header class="detail-head card">
          <div class="head-main">
            <div class="row">
              <h1 class="amount num">₹{{ p.amount }}</h1>
              <pf-status [status]="p.status" />
            </div>
            <div class="mono tiny dim">{{ p.paymentId }}</div>
            @if (p.description) { <div class="small muted">{{ p.description }}</div> }
          </div>

          <div class="head-actions">
            <button class="btn btn--sm" (click)="verify()" [disabled]="busy()">
              Verify with acquirer
            </button>
            @if (canWrite()) {
              @if (p.allowedTransitions.includes('CANCELLED')) {
                <button class="btn btn--sm btn--danger" (click)="cancel()" [disabled]="busy()">
                  Cancel
                </button>
              }
              @if (p.refundableMinor > 0) {
                <button class="btn btn--sm btn--primary" (click)="showRefund.set(!showRefund())"
                        [disabled]="busy()">
                  Refund
                </button>
              }
            }
          </div>
        </header>

        <!-- ── Refund panel ──────────────────────────────────────── -->
        @if (showRefund()) {
          <div class="card refund-panel">
            <div class="card-head">
              <div>
                <div class="card-title">Issue a refund</div>
                <div class="card-sub">
                  Refundable balance: <span class="strong num">₹{{ refundableMajor(p) }}</span>
                </div>
              </div>
            </div>
            <div class="refund-grid">
              <div>
                <label class="label" for="refundAmount">Amount (₹)</label>
                <input id="refundAmount" class="input" type="number" step="0.01" min="0.01"
                       [max]="p.refundableMinor / 100" [(ngModel)]="refundAmount"
                       [placeholder]="refundableMajor(p)" />
                <div class="tiny dim" style="margin-top:5px">
                  Leave blank to refund the full remaining balance
                </div>
              </div>
              <div>
                <label class="label" for="refundReason">Reason</label>
                <select id="refundReason" class="select" [(ngModel)]="refundReason">
                  <option value="REQUESTED_BY_CUSTOMER">Requested by customer</option>
                  <option value="DUPLICATE">Duplicate charge</option>
                  <option value="FRAUDULENT">Fraudulent</option>
                  <option value="MERCHANT_ERROR">Merchant error</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <div class="refund-submit">
                <button class="btn btn--primary" (click)="refund(p)" [disabled]="busy()">
                  @if (busy()) { <span class="spinner"></span> } Confirm refund
                </button>
                <button class="btn btn--ghost" (click)="showRefund.set(false)">Cancel</button>
              </div>
            </div>
          </div>
        }

        <div class="grid detail-grid">
          <!-- ── Facts ───────────────────────────────────────────── -->
          <div class="card">
            <div class="card-head"><div class="card-title">Details</div></div>
            <dl class="facts">
              <dt>Method</dt><dd>{{ p.method }}</dd>
              <dt>Currency</dt><dd>{{ p.currency }}</dd>
              <dt>Platform fee</dt><dd class="num">₹{{ p.fee }}</dd>
              <dt>Refunded</dt><dd class="num">₹{{ p.amountRefunded }}</dd>
              <dt>Refundable</dt><dd class="num">₹{{ refundableMajor(p) }}</dd>
              <dt>Customer</dt><dd>{{ p.customer.email ?? '—' }}</dd>
              @if (p.customer.last4) {
                <dt>Instrument</dt>
                <dd class="mono">{{ p.customer.network ?? 'CARD' }} •••• {{ p.customer.last4 }}</dd>
              }
              <dt>Country</dt><dd>{{ p.customer.country ?? '—' }}</dd>
              @if (p.acquirer?.referenceId) {
                <dt>Acquirer ref</dt><dd class="mono tiny">{{ p.acquirer!.referenceId }}</dd>
                <dt>Auth code</dt><dd class="mono">{{ p.acquirer!.authCode }}</dd>
              }
              <dt>Created</dt><dd>{{ p.createdAt | date: 'dd MMM yyyy, HH:mm:ss' }}</dd>
              @if (p.completedAt) {
                <dt>Completed</dt><dd>{{ p.completedAt | date: 'dd MMM yyyy, HH:mm:ss' }}</dd>
              }
            </dl>

            @if (p.failure) {
              <div class="failure">
                <div class="strong small">{{ p.failure.code }}</div>
                <div class="tiny">{{ p.failure.message }}</div>
              </div>
            }
          </div>

          <!-- ── Risk ────────────────────────────────────────────── -->
          <div class="card">
            <div class="card-head">
              <div class="card-title">Risk assessment</div>
              <pf-status [status]="p.risk.decision" />
            </div>
            <div class="risk-score">
              <div class="score num" [style.color]="riskColor(p.risk.score)">{{ p.risk.score }}</div>
              <div class="score-meta">
                <div class="score-bar">
                  <div class="score-fill" [style.width.%]="p.risk.score"
                       [style.background]="riskColor(p.risk.score)"></div>
                </div>
                <div class="tiny dim">Risk score out of 100</div>
              </div>
            </div>
            @if (p.risk.triggeredRules.length) {
              <div class="rules">
                <div class="tiny dim rules-title">Triggered rules</div>
                @for (rule of p.risk.triggeredRules; track rule) {
                  <span class="badge badge--warning rule-chip">{{ rule.replace('_', ' ') }}</span>
                }
              </div>
            } @else {
              <div class="tiny dim">No rules triggered</div>
            }
          </div>
        </div>

        <!-- ── State history ─────────────────────────────────────── -->
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">State history</div>
              <div class="card-sub">Every transition is appended, never overwritten</div>
            </div>
          </div>
          <ol class="timeline">
            @for (step of p.stateHistory ?? []; track step.at) {
              <li>
                <span class="tl-dot"></span>
                <div class="tl-body">
                  <div class="row">
                    @if (step.from !== 'NONE') {
                      <span class="tiny dim">{{ step.from }}</span>
                      <span class="tiny dim">→</span>
                    }
                    <pf-status [status]="step.to" />
                    <span class="tiny dim">by {{ step.actor }}</span>
                  </div>
                  @if (step.reason) { <div class="tiny muted">{{ step.reason }}</div> }
                  <div class="tiny dim">{{ step.at | date: 'dd MMM yyyy, HH:mm:ss' }}</div>
                </div>
              </li>
            } @empty { <div class="empty">No transitions recorded</div> }
          </ol>
        </div>

        <!-- ── Ledger legs ───────────────────────────────────────── -->
        <div class="card card--flush">
          <div class="card-head" style="padding:16px 18px 0">
            <div>
              <div class="card-title">Ledger entries</div>
              <div class="card-sub">Double-entry legs posted for this payment</div>
            </div>
            @if (entries().length) {
              <span class="badge" [class.badge--success]="balanced()" [class.badge--danger]="!balanced()">
                {{ balanced() ? 'Balanced' : 'Imbalanced' }}
              </span>
            }
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Entry</th><th>Account</th><th>Type</th>
                  <th class="num-cell">Amount</th><th class="num-cell">Balance after</th><th>Posted</th>
                </tr>
              </thead>
              <tbody>
                @for (entry of entries(); track entry.entryId) {
                  <tr>
                    <td class="mono tiny">{{ entry.entryId.slice(0, 14) }}…</td>
                    <td class="mono tiny">{{ entry.accountCode }}</td>
                    <td>
                      <span class="badge"
                            [class.badge--info]="entry.entryType === 'DEBIT'"
                            [class.badge--accent]="entry.entryType === 'CREDIT'">
                        {{ entry.entryType }}
                      </span>
                    </td>
                    <td class="num-cell strong">₹{{ (entry.amountMinor / 100).toFixed(2) }}</td>
                    <td class="num-cell dim">₹{{ (entry.balanceAfterMinor / 100).toFixed(2) }}</td>
                    <td class="dim tiny">{{ entry.postedAt | date: 'dd MMM HH:mm:ss' }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="6">
                    <div class="empty">
                      No ledger entries yet — posting happens asynchronously after capture.
                    </div>
                  </td></tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 16px; }
    .back { color: var(--text-muted); }
    .detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .head-main { display: flex; flex-direction: column; gap: 6px; }
    .amount { font-size: 28px; font-weight: 650; letter-spacing: -0.02em; }
    .head-actions { display: flex; gap: 8px; flex-wrap: wrap; }

    .refund-panel { border-color: var(--accent); }
    .refund-grid { display: grid; gap: 14px; grid-template-columns: 1fr 1fr auto; align-items: end; }
    .refund-submit { display: flex; gap: 8px; }
    @media (max-width: 720px) { .refund-grid { grid-template-columns: 1fr; } }

    .detail-grid { grid-template-columns: 1fr 1fr; }
    @media (max-width: 900px) { .detail-grid { grid-template-columns: 1fr; } }

    .facts { display: grid; grid-template-columns: auto 1fr; gap: 8px 18px; margin: 0; font-size: 13px; }
    .facts dt { color: var(--text-dim); font-size: 12px; }
    .facts dd { margin: 0; text-align: right; }

    .failure {
      margin-top: 14px; padding: 10px 12px;
      background: var(--danger-soft); color: var(--danger); border-radius: var(--radius-sm);
    }

    .risk-score { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
    .score { font-size: 38px; font-weight: 700; line-height: 1; min-width: 60px; }
    .score-meta { flex: 1; }
    .score-bar { height: 7px; background: var(--surface-3); border-radius: 4px; overflow: hidden; margin-bottom: 5px; }
    .score-fill { height: 100%; border-radius: 4px; transition: width .3s; }
    .rules-title { margin-bottom: 7px; }
    .rule-chip { margin: 0 5px 5px 0; }

    .timeline { list-style: none; margin: 0; padding: 0 0 0 6px; }
    .timeline li { display: flex; gap: 14px; padding-bottom: 16px; position: relative; }
    .timeline li:not(:last-child)::before {
      content: ''; position: absolute; left: 4px; top: 14px; bottom: 0;
      width: 1px; background: var(--border);
    }
    .tl-dot {
      width: 9px; height: 9px; border-radius: 50%;
      background: var(--accent); margin-top: 5px; flex-shrink: 0; z-index: 1;
    }
    .tl-body { display: flex; flex-direction: column; gap: 3px; }
  `],
})
export class PaymentDetailComponent implements OnInit {
  private readonly api = inject(PaymentApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  /** Bound from the route via `withComponentInputBinding()`. */
  @Input() paymentId = '';

  readonly payment = signal<Payment | null>(null);
  readonly entries = signal<LedgerEntry[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly showRefund = signal(false);
  readonly canWrite = this.auth.canWrite;

  refundAmount: number | null = null;
  refundReason = 'REQUESTED_BY_CUSTOMER';

  ngOnInit(): void { this.load(); }

  private load(): void {
    this.loading.set(true);
    this.api.getPayment(this.paymentId).subscribe({
      next: (payment) => { this.payment.set(payment); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
    this.api.entriesFor('Payment', this.paymentId)
      .subscribe({ next: (entries) => this.entries.set(entries), error: () => undefined });
  }

  refundableMajor(payment: Payment): string {
    return (payment.refundableMinor / 100).toFixed(2);
  }

  riskColor(score: number): string {
    if (score >= 80) return 'var(--danger)';
    if (score >= 50) return 'var(--warning)';
    return 'var(--success)';
  }

  /** Debits must equal credits for the payment's journal. */
  balanced(): boolean {
    const entries = this.entries();
    if (!entries.length) return true;
    const debit = entries.filter((e) => e.entryType === 'DEBIT')
      .reduce((sum, e) => sum + e.amountMinor, 0);
    const credit = entries.filter((e) => e.entryType === 'CREDIT')
      .reduce((sum, e) => sum + e.amountMinor, 0);
    return debit === credit;
  }

  verify(): void {
    this.busy.set(true);
    this.api.verifyPayment(this.paymentId).subscribe({
      next: (payment) => {
        this.payment.set(payment);
        this.busy.set(false);
        this.toast.info('Verified', `Payment is ${payment.status}`);
      },
      error: () => this.busy.set(false),
    });
  }

  cancel(): void {
    this.busy.set(true);
    this.api.cancelPayment(this.paymentId, 'Cancelled from console').subscribe({
      next: (payment) => {
        this.payment.set(payment);
        this.busy.set(false);
        this.toast.success('Payment cancelled');
      },
      error: () => this.busy.set(false),
    });
  }

  refund(payment: Payment): void {
    this.busy.set(true);
    // Convert to minor units here; the API rejects decimal amounts outright.
    const amountMinor = this.refundAmount
      ? Math.round(this.refundAmount * 100)
      : undefined;

    this.api.refundPayment(this.paymentId, { amountMinor, reason: this.refundReason }).subscribe({
      next: (refund) => {
        this.busy.set(false);
        this.showRefund.set(false);
        this.refundAmount = null;
        this.toast.success(`Refund ${refund.status}`, `₹${refund.amount} against ${payment.paymentId}`);
        this.load();
      },
      error: () => this.busy.set(false),
    });
  }
}
