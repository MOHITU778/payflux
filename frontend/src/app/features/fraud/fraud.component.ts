import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { PaymentApiService } from '../../core/services/payment.service';
import { FraudAlert, Page } from '../../core/models';
import { StatusBadgeComponent } from '../../shared/components/status-badge.component';
import { PaginationComponent } from '../../shared/components/pagination.component';
import { DonutChartComponent } from '../../shared/components/chart.component';

/**
 * Risk console.
 *
 * The score distribution chart is the operationally useful part: it shows where
 * the block threshold currently sits relative to real traffic, which is what
 * makes tuning the threshold an evidence-based decision rather than a guess.
 */
@Component({
  selector: 'pf-fraud',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, StatusBadgeComponent, PaginationComponent, DonutChartComponent],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Risk &amp; fraud</h1>
          <p class="page-sub">Rule-based scoring on every payment attempt</p>
        </div>
        <select class="select range-select" [(ngModel)]="range" (ngModelChange)="loadAll()"
                aria-label="Time range">
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
        </select>
      </header>

      <section class="grid top-grid">
        <div class="card">
          <div class="card-head"><div class="card-title">Decisions</div></div>
          <pf-donut [slices]="decisionSlices()" caption="scored"
                    [palette]="['var(--c2)', 'var(--c3)', 'var(--c6)']"
                    ariaLabel="Fraud decisions" />
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Score distribution</div>
              <div class="card-sub">Where the block threshold sits against live traffic</div>
            </div>
          </div>
          <div class="histogram">
            @for (bucket of histogram(); track bucket.from) {
              <div class="hist-col" [title]="bucket.from + '–' + (bucket.from + 9) + ': ' + bucket.count">
                <div class="hist-bar" [style.height.%]="bucket.height"
                     [style.background]="bucketColor(bucket.from)"></div>
                <div class="hist-label tiny dim">{{ bucket.from }}</div>
              </div>
            } @empty { <div class="empty">No scored payments in this period</div> }
          </div>
          <div class="hist-legend tiny dim">
            <span><i class="swatch" style="background:var(--c2)"></i> allow</span>
            <span><i class="swatch" style="background:var(--c3)"></i> review (≥50)</span>
            <span><i class="swatch" style="background:var(--c6)"></i> block (≥80)</span>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div>
            <div class="card-title">Most-triggered rules</div>
            <div class="card-sub">What is actually firing — the input to tuning weights</div>
          </div>
        </div>
        <div class="rules">
          @for (rule of topRules(); track rule.ruleId) {
            <div class="rule-row">
              <div class="rule-id mono tiny">{{ rule.ruleId }}</div>
              <div class="rule-track">
                <div class="rule-fill" [style.width.%]="rulePercent(rule.hits)"></div>
              </div>
              <div class="rule-hits num">{{ rule.hits }}</div>
              <div class="rule-blocks tiny" [class.text-danger]="rule.blocks > 0">
                {{ rule.blocks }} blocks
              </div>
              <div class="rule-score tiny dim">avg {{ rule.avgScore }}</div>
            </div>
          } @empty { <div class="empty">No rules triggered in this period</div> }
        </div>
      </section>

      <section class="card card--flush">
        <div class="card-head alerts-head">
          <div>
            <div class="card-title">Alerts</div>
            <div class="card-sub">Payments the engine blocked or flagged for review</div>
          </div>
          <select class="select decision-select" [(ngModel)]="decision" (ngModelChange)="loadAlerts(1)"
                  aria-label="Filter by decision">
            <option value="">Block &amp; review</option>
            <option value="BLOCK">Blocked only</option>
            <option value="REVIEW">Review only</option>
          </select>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th class="num-cell">Score</th><th>Decision</th><th>Payment</th>
                <th>Rules</th><th>Customer</th><th>IP</th><th>When</th>
              </tr>
            </thead>
            <tbody>
              @for (alert of alerts()?.items ?? []; track alert.fraudLogId) {
                <tr>
                  <td class="num-cell">
                    <span class="score-pill" [style.background]="scoreBg(alert.riskScore)"
                          [style.color]="scoreColor(alert.riskScore)">{{ alert.riskScore }}</span>
                  </td>
                  <td><pf-status [status]="alert.decision" /></td>
                  <td>
                    @if (alert.paymentId) {
                      <a [routerLink]="['/transactions', alert.paymentId]" class="mono tiny">
                        {{ alert.paymentId.slice(0, 16) }}…
                      </a>
                    } @else { <span class="dim">—</span> }
                  </td>
                  <td>
                    @for (rule of alert.triggeredRules.slice(0, 2); track rule.ruleId) {
                      <span class="badge badge--warning rule-chip"
                            [title]="rule.detail ?? rule.ruleName">{{ rule.ruleId }}</span>
                    }
                    @if (alert.triggeredRules.length > 2) {
                      <span class="tiny dim">+{{ alert.triggeredRules.length - 2 }}</span>
                    }
                  </td>
                  <td class="dim tiny">{{ alert.signals.customerEmail ?? '—' }}</td>
                  <td class="mono tiny dim">{{ alert.signals.ipAddress ?? '—' }}</td>
                  <td class="dim tiny">{{ alert.createdAt | date: 'dd MMM HH:mm' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="7"><div class="empty">No alerts — nothing has been flagged</div></td></tr>
              }
            </tbody>
          </table>
        </div>
        <pf-pagination [pagination]="alerts()?.pagination ?? null" (pageChange)="loadAlerts($event)" />
      </section>
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 16px; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .page-title { font-size: 20px; }
    .page-sub { margin: 3px 0 0; font-size: 12px; color: var(--text-dim); }
    .range-select, .decision-select { width: auto; min-width: 150px; }
    .top-grid { grid-template-columns: 1fr 1.6fr; }
    @media (max-width: 980px) { .top-grid { grid-template-columns: 1fr; } }

    .histogram { display: flex; align-items: flex-end; gap: 5px; height: 150px; padding-top: 8px; }
    .hist-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; gap: 5px; }
    .hist-bar { border-radius: 3px 3px 0 0; min-height: 2px; transition: height .3s; }
    .hist-label { text-align: center; }
    .hist-legend { display: flex; gap: 16px; margin-top: 12px; }
    .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }

    .rules { display: flex; flex-direction: column; gap: 9px; }
    .rule-row {
      display: grid; grid-template-columns: 210px 1fr 48px 76px 62px;
      align-items: center; gap: 10px;
    }
    .rule-track { height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; }
    .rule-fill { height: 100%; background: var(--c3); border-radius: 3px; }
    .rule-hits { text-align: right; font-weight: 600; font-size: 12px; }
    .rule-blocks, .rule-score { text-align: right; }
    @media (max-width: 760px) { .rule-row { grid-template-columns: 1fr 46px; } .rule-track, .rule-blocks, .rule-score { display: none; } }

    .alerts-head { padding: 16px 18px 0; margin-bottom: 12px; }
    .score-pill {
      display: inline-block; min-width: 30px; padding: 2px 7px;
      border-radius: 5px; font-weight: 700; font-size: 12px; text-align: center;
    }
    .rule-chip { margin-right: 4px; }
  `],
})
export class FraudComponent implements OnInit {
  private readonly api = inject(PaymentApiService);

  readonly alerts = signal<Page<FraudAlert> | null>(null);
  readonly analytics = signal<{
    breakdown: { _id: string; count: number; avgScore: number }[];
    topRules: { ruleId: string; name: string; hits: number; blocks: number; avgScore: number }[];
    distribution: { from: number; count: number }[];
  } | null>(null);

  range = '30d';
  decision = '';

  ngOnInit(): void { this.loadAll(); }

  loadAll(): void {
    this.api.fraudAnalytics({ range: this.range })
      .subscribe({ next: (data) => this.analytics.set(data), error: () => undefined });
    this.loadAlerts(1);
  }

  loadAlerts(page: number): void {
    this.api.fraudAlerts({ page, limit: 20, range: this.range, decision: this.decision || undefined })
      .subscribe({ next: (result) => this.alerts.set(result), error: () => undefined });
  }

  decisionSlices() {
    const order: Record<string, number> = { ALLOW: 0, REVIEW: 1, BLOCK: 2 };
    return (this.analytics()?.breakdown ?? [])
      .slice()
      .sort((a, b) => (order[a._id] ?? 9) - (order[b._id] ?? 9))
      .map((row) => ({ label: row._id, value: row.count }));
  }

  topRules() { return this.analytics()?.topRules ?? []; }

  rulePercent(hits: number): number {
    const max = Math.max(1, ...this.topRules().map((rule) => rule.hits));
    return (hits / max) * 100;
  }

  histogram() {
    const buckets = this.analytics()?.distribution ?? [];
    const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
    return buckets
      .filter((bucket) => typeof bucket.from === 'number')
      .map((bucket) => ({
        from: bucket.from,
        count: bucket.count,
        height: (bucket.count / max) * 100,
      }));
  }

  /** Colour each histogram column by the band its scores fall into. */
  bucketColor(from: number): string {
    if (from >= 80) return 'var(--c6)';
    if (from >= 50) return 'var(--c3)';
    return 'var(--c2)';
  }

  scoreColor(score: number): string {
    if (score >= 80) return 'var(--danger)';
    if (score >= 50) return 'var(--warning)';
    return 'var(--success)';
  }

  scoreBg(score: number): string {
    if (score >= 80) return 'var(--danger-soft)';
    if (score >= 50) return 'var(--warning-soft)';
    return 'var(--success-soft)';
  }
}
