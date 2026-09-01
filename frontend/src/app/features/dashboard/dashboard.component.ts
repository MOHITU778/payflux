import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Subscription, interval, startWith, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { PaymentApiService } from '../../core/services/payment.service';
import { AnalyticsOverview, Payment, Settlement, TimeSeries } from '../../core/models';
import { StatCardComponent } from '../../shared/components/stat-card.component';
import { StatusBadgeComponent } from '../../shared/components/status-badge.component';
import { BarChartComponent, DonutChartComponent, SeriesPoint } from '../../shared/components/chart.component';

/**
 * Operations dashboard.
 *
 * Live-refreshes on a timer. Two details make that safe:
 *   • the poll uses `switchMap`, so a slow response is cancelled when the next
 *     tick fires rather than queueing up and arriving out of order;
 *   • the subscription is torn down in `ngOnDestroy`, otherwise navigating away
 *     would leave an HTTP request firing every 15 seconds for the life of the
 *     tab — a leak that only shows up after someone has left the app open
 *     overnight.
 */
@Component({
  selector: 'pf-dashboard',
  standalone: true,
  imports: [
    CommonModule, RouterLink, StatCardComponent, StatusBadgeComponent,
    BarChartComponent, DonutChartComponent,
  ],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Dashboard</h1>
          <p class="page-sub">
            Live payment operations
            @if (lastUpdated()) { · updated {{ lastUpdated() | date: 'HH:mm:ss' }} }
          </p>
        </div>
        <div class="row">
          <select class="select range-select" [value]="range()" (change)="setRange($event)"
                  aria-label="Time range">
            <option value="1h">Last hour</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
          <button class="btn btn--sm" (click)="refresh()" [disabled]="loading()">
            @if (loading()) { <span class="spinner"></span> } @else { ↻ } Refresh
          </button>
        </div>
      </header>

      <!-- ── Headline metrics ──────────────────────────────────────── -->
      <section class="stats">
        <pf-stat label="Gross volume" [value]="overview()?.headline?.grossVolume ?? '—'"
                 prefix="₹" [loading]="loading() && !overview()"
                 [hint]="(overview()?.headline?.totalPayments ?? 0) + ' payments'" />
        <pf-stat label="Net revenue" [value]="overview()?.headline?.netRevenue ?? '—'"
                 prefix="₹" [loading]="loading() && !overview()"
                 [hint]="'after ₹' + (overview()?.headline?.refunded ?? '0') + ' refunded'" />
        <pf-stat label="Success rate" [value]="successRate()"
                 [loading]="loading() && !overview()"
                 [accent]="successRateColor()"
                 [hint]="(overview()?.headline?.succeededPayments ?? 0) + ' succeeded'" />
        <pf-stat label="Failed payments" [value]="overview()?.headline?.failedPayments ?? '—'"
                 [loading]="loading() && !overview()"
                 [accent]="(overview()?.headline?.failedPayments ?? 0) > 0 ? 'var(--danger)' : ''"
                 [hint]="topFailureReason()" />
        <pf-stat label="Platform fees" [value]="overview()?.headline?.platformFee ?? '—'"
                 prefix="₹" [loading]="loading() && !overview()" hint="recognised revenue" />
        <pf-stat label="Avg ticket" [value]="averageTicket()"
                 prefix="₹" [loading]="loading() && !overview()" hint="per payment" />
      </section>

      <!-- ── Charts ────────────────────────────────────────────────── -->
      <section class="grid charts">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Payment volume</div>
              <div class="card-sub">Succeeded vs failed, by {{ series()?.unit ?? 'period' }}</div>
            </div>
          </div>
          <pf-bar-chart [series]="chartSeries()" ariaLabel="Payment volume over time" />
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">By payment method</div>
          </div>
          <pf-donut [slices]="methodSlices()" caption="payments" ariaLabel="Payments by method" />
        </div>
      </section>

      <section class="grid charts">
        <div class="card">
          <div class="card-head"><div class="card-title">Status breakdown</div></div>
          <div class="bars">
            @for (row of statusRows(); track row.status) {
              <div class="bar-row">
                <pf-status [status]="row.status" />
                <div class="bar-track">
                  <div class="bar-fill" [style.width.%]="row.percent"
                       [style.background]="row.color"></div>
                </div>
                <span class="bar-count num">{{ row.count }}</span>
                <span class="bar-pct num dim">{{ row.percent }}%</span>
              </div>
            } @empty {
              <div class="empty">No payments in this period</div>
            }
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">Risk decisions</div>
            <a routerLink="/fraud" class="tiny">View alerts →</a>
          </div>
          <pf-donut [slices]="fraudSlices()" caption="scored"
                    [palette]="['var(--c2)', 'var(--c3)', 'var(--c6)']"
                    ariaLabel="Fraud engine decisions" />
        </div>
      </section>

      <!-- ── Operational tiles ─────────────────────────────────────── -->
      <section class="grid charts">
        <div class="card">
          <div class="card-head">
            <div class="card-title">Settlement queue</div>
            <a routerLink="/settlements" class="tiny">All settlements →</a>
          </div>
          @if (settlements().length) {
            <table class="data compact">
              <tbody>
                @for (item of settlements().slice(0, 5); track item.settlementId) {
                  <tr>
                    <td class="mono tiny">{{ item.settlementId.slice(0, 16) }}…</td>
                    <td><pf-status [status]="item.status" /></td>
                    <td class="num-cell">₹{{ item.net }}</td>
                    <td class="dim tiny">{{ item.paymentCount }} pmts</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty">Nothing awaiting payout</div>
          }
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">Queue depth</div>
            <div class="card-sub">Async pipeline</div>
          </div>
          <div class="queues">
            @for (queue of queues(); track queue.queue) {
              <div class="queue-row">
                <span class="queue-name mono tiny">{{ queue.queue }}</span>
                <span class="queue-stat" title="waiting">
                  <span class="num">{{ queue.waiting ?? 0 }}</span><span class="dim tiny"> wait</span>
                </span>
                <span class="queue-stat" title="active">
                  <span class="num">{{ queue.active ?? 0 }}</span><span class="dim tiny"> act</span>
                </span>
                <span class="queue-stat" [class.text-danger]="(queue.failed ?? 0) > 0" title="failed">
                  <span class="num">{{ queue.failed ?? 0 }}</span><span class="dim tiny"> fail</span>
                </span>
              </div>
            } @empty { <div class="empty">Queue metrics unavailable</div> }
          </div>
        </div>
      </section>

      <!-- ── Recent transactions ───────────────────────────────────── -->
      <section class="card card--flush">
        <div class="card-head recent-head">
          <div class="card-title">Recent payments</div>
          <a routerLink="/transactions" class="tiny">View all →</a>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Payment</th><th>Status</th><th>Method</th>
                <th class="num-cell">Amount</th><th class="num-cell">Risk</th>
                <th>Customer</th><th>Created</th>
              </tr>
            </thead>
            <tbody>
              @for (payment of recent(); track payment.paymentId) {
                <tr class="clickable" [routerLink]="['/transactions', payment.paymentId]">
                  <td class="mono tiny">{{ payment.paymentId }}</td>
                  <td><pf-status [status]="payment.status" /></td>
                  <td class="dim">{{ payment.method }}</td>
                  <td class="num-cell strong">₹{{ payment.amount }}</td>
                  <td class="num-cell">
                    <span [class.text-danger]="payment.risk.score >= 80"
                          [class.text-warning]="payment.risk.score >= 50 && payment.risk.score < 80">
                      {{ payment.risk.score }}
                    </span>
                  </td>
                  <td class="dim tiny">{{ payment.customer.email ?? '—' }}</td>
                  <td class="dim tiny">{{ payment.createdAt | date: 'dd MMM HH:mm' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="7"><div class="empty">No payments yet</div></td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 16px; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .page-title { font-size: 20px; }
    .page-sub { margin: 3px 0 0; font-size: 12px; color: var(--text-dim); }
    .range-select { width: auto; min-width: 140px; }

    .stats { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .charts { grid-template-columns: 2fr 1fr; }
    @media (max-width: 1000px) { .charts { grid-template-columns: 1fr; } }

    .bars { display: flex; flex-direction: column; gap: 10px; }
    .bar-row { display: grid; grid-template-columns: 130px 1fr 46px 44px; align-items: center; gap: 10px; }
    .bar-track { height: 7px; background: var(--surface-3); border-radius: 4px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
    .bar-count { text-align: right; font-size: 12px; font-weight: 600; }
    .bar-pct { text-align: right; font-size: 11px; }

    .queues { display: flex; flex-direction: column; gap: 7px; }
    .queue-row {
      display: grid; grid-template-columns: 1fr auto auto auto; gap: 12px;
      align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border);
    }
    .queue-row:last-child { border-bottom: none; }
    .queue-stat { font-size: 12px; min-width: 52px; text-align: right; }

    .recent-head { padding: 16px 18px 0; margin-bottom: 12px; }
    table.compact td { padding: 7px 0; border-bottom: 1px solid var(--border); }
    .clickable { cursor: pointer; }
  `],
})
export class DashboardComponent implements OnInit, OnDestroy {
  private readonly api = inject(PaymentApiService);
  private poll?: Subscription;

  readonly overview = signal<AnalyticsOverview | null>(null);
  readonly series = signal<TimeSeries | null>(null);
  readonly recent = signal<Payment[]>([]);
  readonly settlements = signal<Settlement[]>([]);
  readonly loading = signal(true);
  readonly range = signal('7d');
  readonly lastUpdated = signal<Date | null>(null);

  ngOnInit(): void {
    this.poll = interval(environment.pollIntervalMs)
      .pipe(startWith(0), switchMap(() => this.load()))
      .subscribe();
  }

  ngOnDestroy(): void {
    // Without this the timer keeps firing HTTP requests after the component is
    // gone — a classic Angular leak.
    this.poll?.unsubscribe();
  }

  private load() {
    this.loading.set(true);
    const query = { range: this.range(), currency: 'INR' };

    // Independent requests, issued together: the dashboard's latency is the
    // slowest of the four, not their sum.
    this.api.overview(query).subscribe({
      next: (data) => { this.overview.set(data); this.lastUpdated.set(new Date()); },
      error: () => undefined,   // the error interceptor already surfaced it
      complete: () => this.loading.set(false),
    });
    this.api.timeSeries(query).subscribe({ next: (data) => this.series.set(data), error: () => undefined });
    this.api.listPayments({ limit: 8, sort: '-createdAt' })
      .subscribe({ next: (page) => this.recent.set(page.items), error: () => undefined });
    this.api.settlementQueue()
      .subscribe({ next: (list) => this.settlements.set(list), error: () => undefined });

    return [];
  }

  refresh(): void { this.load(); }

  setRange(event: Event): void {
    this.range.set((event.target as HTMLSelectElement).value);
    this.load();
  }

  // ── Derived view data ────────────────────────────────────────────────

  successRate(): string {
    const rate = this.overview()?.headline.successRate;
    return rate === undefined ? '—' : `${rate}%`;
  }

  successRateColor(): string {
    const rate = this.overview()?.headline.successRate ?? 100;
    // Card-not-present success rates below ~85% signal a real problem.
    if (rate < 75) return 'var(--danger)';
    if (rate < 88) return 'var(--warning)';
    return 'var(--success)';
  }

  averageTicket(): string {
    const minor = this.overview()?.headline.averageTicketMinor;
    return minor === undefined ? '—' : (minor / 100).toFixed(2);
  }

  topFailureReason(): string {
    const top = this.overview()?.topFailureReasons?.[0];
    return top ? `top: ${top._id.replace(/_/g, ' ').toLowerCase()}` : '';
  }

  chartSeries(): SeriesPoint[] {
    const points = this.series()?.points ?? [];
    const unit = this.series()?.unit ?? 'day';
    return points.map((point) => ({
      label: this.formatBucket(point.bucket, unit),
      value: point.succeeded,
      secondary: point.failed,
    }));
  }

  private formatBucket(iso: string, unit: string): string {
    const date = new Date(iso);
    if (unit === 'hour') return `${String(date.getHours()).padStart(2, '0')}:00`;
    return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  }

  methodSlices() {
    return (this.overview()?.byMethod ?? []).map((row) => ({ label: row.method, value: row.count }));
  }

  fraudSlices() {
    const order = { ALLOW: 0, REVIEW: 1, BLOCK: 2 } as Record<string, number>;
    return (this.overview()?.fraud ?? [])
      .slice()
      .sort((a, b) => (order[a.decision] ?? 9) - (order[b.decision] ?? 9))
      .map((row) => ({ label: row.decision, value: row.count }));
  }

  statusRows() {
    const rows = this.overview()?.byStatus ?? [];
    const total = rows.reduce((sum, row) => sum + row.count, 0) || 1;
    const colors: Record<string, string> = {
      SUCCESS: 'var(--success)', FAILED: 'var(--danger)', PENDING: 'var(--warning)',
      PROCESSING: 'var(--warning)', REFUNDED: 'var(--accent)',
      PARTIALLY_REFUNDED: 'var(--info)', CANCELLED: 'var(--neutral)',
    };
    return rows
      .slice()
      .sort((a, b) => b.count - a.count)
      .map((row) => ({
        status: row.status,
        count: row.count,
        percent: Math.round((row.count / total) * 1000) / 10,
        color: colors[row.status] ?? 'var(--neutral)',
      }));
  }

  queues() {
    return this.overview()?.queues ?? [];
  }
}
