import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PaymentApiService } from '../../core/services/payment.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { Page, WebhookDelivery, WebhookEndpoint } from '../../core/models';
import { StatusBadgeComponent } from '../../shared/components/status-badge.component';
import { PaginationComponent } from '../../shared/components/pagination.component';

type Tab = 'endpoints' | 'deliveries' | 'dlq';

/**
 * Webhook management: endpoints, delivery log, and the dead-letter queue.
 *
 * The DLQ is treated as an inbox rather than a graveyard — each row can be
 * replayed once the underlying cause is fixed, which is the difference between
 * "we lost the event" and "we redelivered it".
 */
@Component({
  selector: 'pf-webhooks',
  standalone: true,
  imports: [CommonModule, FormsModule, StatusBadgeComponent, PaginationComponent],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Webhooks</h1>
          <p class="page-sub">
            At-least-once delivery, HMAC-signed, with a published retry ladder
          </p>
        </div>
        @if (canWrite()) {
          <button class="btn btn--primary btn--sm" (click)="showCreate.set(!showCreate())">
            + Add endpoint
          </button>
        }
      </header>

      @if (showCreate()) {
        <div class="card create-panel">
          <div class="card-head"><div class="card-title">Register an endpoint</div></div>
          <div class="create-grid">
            <div>
              <label class="label" for="url">Destination URL</label>
              <input id="url" class="input" [(ngModel)]="newUrl" placeholder="https://api.example.com/hooks/payflux" />
            </div>
            <div>
              <label class="label" for="desc">Description</label>
              <input id="desc" class="input" [(ngModel)]="newDescription" placeholder="Production sink" />
            </div>
            <div class="create-actions">
              <button class="btn btn--primary" (click)="createEndpoint()" [disabled]="!newUrl || busy()">
                Create
              </button>
              <button class="btn btn--ghost" (click)="showCreate.set(false)">Cancel</button>
            </div>
          </div>
          <div class="tiny dim create-note">
            Subscribing to no specific events means every event type is delivered.
          </div>
        </div>
      }

      @if (revealedSecret(); as secret) {
        <div class="card secret-panel">
          <div class="card-title">Signing secret — shown once</div>
          <div class="small muted secret-note">
            Store this now. It is hashed server-side and cannot be retrieved again.
            Verify inbound requests by computing
            <code class="mono">HMAC-SHA256(secret, "{{ '{timestamp}' }}.{{ '{rawBody}' }}")</code>
            and comparing it to the <code class="mono">v1</code> value in the signature header.
          </div>
          <div class="secret-value mono">{{ secret }}</div>
          <button class="btn btn--sm" (click)="revealedSecret.set(null)">I've stored it</button>
        </div>
      }

      <nav class="tabs" role="tablist">
        <button class="tab" [class.tab--active]="tab() === 'endpoints'" role="tab"
                [attr.aria-selected]="tab() === 'endpoints'" (click)="setTab('endpoints')">
          Endpoints <span class="tab-count">{{ endpoints().length }}</span>
        </button>
        <button class="tab" [class.tab--active]="tab() === 'deliveries'" role="tab"
                [attr.aria-selected]="tab() === 'deliveries'" (click)="setTab('deliveries')">
          Delivery log
        </button>
        <button class="tab" [class.tab--active]="tab() === 'dlq'" role="tab"
                [attr.aria-selected]="tab() === 'dlq'" (click)="setTab('dlq')">
          Dead letter
          @if (dlqCount() > 0) { <span class="tab-count tab-count--alert">{{ dlqCount() }}</span> }
        </button>
      </nav>

      <!-- ── Endpoints ─────────────────────────────────────────────── -->
      @if (tab() === 'endpoints') {
        <div class="endpoint-list">
          @for (endpoint of endpoints(); track endpoint.endpointId) {
            <div class="card endpoint">
              <div class="endpoint-head">
                <div class="endpoint-main">
                  <div class="row">
                    <span class="badge" [class.badge--success]="endpoint.isActive"
                          [class.badge--neutral]="!endpoint.isActive">
                      {{ endpoint.isActive ? 'Active' : 'Disabled' }}
                    </span>
                    <span class="endpoint-url mono">{{ endpoint.url }}</span>
                  </div>
                  @if (endpoint.description) {
                    <div class="small muted">{{ endpoint.description }}</div>
                  }
                </div>
                @if (canWrite()) {
                  <button class="btn btn--sm" (click)="toggleEndpoint(endpoint)">
                    {{ endpoint.isActive ? 'Disable' : 'Enable' }}
                  </button>
                }
              </div>

              <div class="endpoint-meta">
                <div class="meta">
                  <span class="tiny dim">Events</span>
                  <span class="small">
                    {{ endpoint.subscribedEvents.length ? endpoint.subscribedEvents.length + ' subscribed' : 'All events' }}
                  </span>
                </div>
                <div class="meta">
                  <span class="tiny dim">Consecutive failures</span>
                  <span class="small" [class.text-danger]="endpoint.health.consecutiveFailures > 0">
                    {{ endpoint.health.consecutiveFailures }}
                  </span>
                </div>
                <div class="meta">
                  <span class="tiny dim">Last success</span>
                  <span class="small">
                    {{ endpoint.health.lastSuccessAt ? (endpoint.health.lastSuccessAt | date: 'dd MMM HH:mm') : 'never' }}
                  </span>
                </div>
                <div class="meta">
                  <span class="tiny dim">Retry ladder</span>
                  <span class="small mono">{{ formatLadder(endpoint.retrySchedule) }}</span>
                </div>
              </div>

              @if (endpoint.health.lastFailureReason) {
                <div class="endpoint-failure tiny">
                  Last failure: {{ endpoint.health.lastFailureReason }}
                </div>
              }
            </div>
          } @empty {
            <div class="card"><div class="empty">
              No endpoints registered. Add one to start receiving events.
            </div></div>
          }
        </div>
      }

      <!-- ── Delivery log / DLQ ────────────────────────────────────── -->
      @if (tab() !== 'endpoints') {
        <div class="card card--flush">
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Event</th><th>Status</th><th class="num-cell">Attempts</th>
                  <th>Destination</th><th>Last result</th><th>Next retry</th>
                  <th>Created</th>@if (tab() === 'dlq' && canWrite()) { <th></th> }
                </tr>
              </thead>
              <tbody>
                @for (delivery of deliveries()?.items ?? []; track delivery.deliveryId) {
                  <tr>
                    <td>
                      <div class="small">{{ delivery.eventType }}</div>
                      <div class="mono tiny dim">{{ delivery.eventId.slice(0, 18) }}…</div>
                    </td>
                    <td><pf-status [status]="delivery.status" /></td>
                    <td class="num-cell">
                      {{ delivery.attemptCount }}<span class="dim">/{{ delivery.maxAttempts }}</span>
                    </td>
                    <td class="mono tiny dim">{{ truncate(delivery.url) }}</td>
                    <td>
                      @if (lastAttempt(delivery); as attempt) {
                        @if (attempt.statusCode) {
                          <span class="badge"
                                [class.badge--success]="attempt.statusCode < 300"
                                [class.badge--danger]="attempt.statusCode >= 400">
                            HTTP {{ attempt.statusCode }}
                          </span>
                        } @else {
                          <span class="badge badge--danger" [title]="attempt.error ?? ''">error</span>
                        }
                        <span class="tiny dim"> {{ attempt.durationMs }}ms</span>
                      } @else { <span class="dim">—</span> }
                    </td>
                    <td class="dim tiny">
                      {{ delivery.nextAttemptAt ? (delivery.nextAttemptAt | date: 'dd MMM HH:mm') : '—' }}
                    </td>
                    <td class="dim tiny">{{ delivery.createdAt | date: 'dd MMM HH:mm' }}</td>
                    @if (tab() === 'dlq' && canWrite()) {
                      <td>
                        <button class="btn btn--sm" (click)="replay(delivery)" [disabled]="busy()">
                          Replay
                        </button>
                      </td>
                    }
                  </tr>
                } @empty {
                  <tr><td colspan="8"><div class="empty">
                    {{ tab() === 'dlq' ? 'Dead-letter queue is empty — every event was delivered.' : 'No deliveries yet' }}
                  </div></td></tr>
                }
              </tbody>
            </table>
          </div>
          <pf-pagination [pagination]="deliveries()?.pagination ?? null" (pageChange)="loadDeliveries($event)" />
        </div>
      }
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 16px; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .page-title { font-size: 20px; }
    .page-sub { margin: 3px 0 0; font-size: 12px; color: var(--text-dim); }

    .create-panel { border-color: var(--accent); }
    .create-grid { display: grid; gap: 14px; grid-template-columns: 2fr 1fr auto; align-items: end; }
    .create-actions { display: flex; gap: 8px; }
    .create-note { margin-top: 10px; }
    @media (max-width: 760px) { .create-grid { grid-template-columns: 1fr; } }

    .secret-panel { border-color: var(--warning); background: var(--warning-soft); }
    .secret-note { margin: 8px 0 12px; }
    .secret-value {
      background: var(--bg); padding: 12px 14px; border-radius: var(--radius-sm);
      word-break: break-all; font-size: 12px; margin-bottom: 12px;
      border: 1px solid var(--border);
    }
    code { background: var(--surface-3); padding: 1px 5px; border-radius: 3px; font-size: 11px; }

    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
    .tab {
      padding: 9px 15px; background: none; border: none; border-bottom: 2px solid transparent;
      color: var(--text-muted); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
      display: inline-flex; align-items: center; gap: 7px;
    }
    .tab:hover { color: var(--text); }
    .tab--active { color: var(--accent); border-bottom-color: var(--accent); }
    .tab-count {
      background: var(--surface-3); padding: 1px 7px; border-radius: 999px;
      font-size: 11px; font-weight: 600;
    }
    .tab-count--alert { background: var(--danger-soft); color: var(--danger); }

    .endpoint-list { display: flex; flex-direction: column; gap: 12px; }
    .endpoint-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
    .endpoint-main { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .endpoint-url { font-size: 12px; word-break: break-all; }
    .endpoint-meta {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 14px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border);
    }
    .meta { display: flex; flex-direction: column; gap: 3px; }
    .endpoint-failure {
      margin-top: 12px; padding: 8px 10px;
      background: var(--danger-soft); color: var(--danger); border-radius: var(--radius-sm);
    }
  `],
})
export class WebhooksComponent implements OnInit {
  private readonly api = inject(PaymentApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  readonly endpoints = signal<WebhookEndpoint[]>([]);
  readonly deliveries = signal<Page<WebhookDelivery> | null>(null);
  readonly dlqCount = signal(0);
  readonly tab = signal<Tab>('endpoints');
  readonly showCreate = signal(false);
  readonly revealedSecret = signal<string | null>(null);
  readonly busy = signal(false);
  readonly canWrite = this.auth.canWrite;

  newUrl = '';
  newDescription = '';

  ngOnInit(): void {
    this.loadEndpoints();
    // Fetch the DLQ count up front so the tab badge is accurate before it is opened.
    this.api.deadLetterQueue({ limit: 1 })
      .subscribe({ next: (page) => this.dlqCount.set(page.pagination.total), error: () => undefined });
  }

  setTab(tab: Tab): void {
    this.tab.set(tab);
    if (tab !== 'endpoints') this.loadDeliveries(1);
  }

  loadEndpoints(): void {
    this.api.listEndpoints()
      .subscribe({ next: (list) => this.endpoints.set(list), error: () => undefined });
  }

  loadDeliveries(page: number): void {
    const request = this.tab() === 'dlq'
      ? this.api.deadLetterQueue({ page, limit: 20 })
      : this.api.listDeliveries({ page, limit: 20 });
    request.subscribe({
      next: (result) => {
        this.deliveries.set(result);
        if (this.tab() === 'dlq') this.dlqCount.set(result.pagination.total);
      },
      error: () => undefined,
    });
  }

  createEndpoint(): void {
    this.busy.set(true);
    this.api.createEndpoint({ url: this.newUrl, description: this.newDescription || undefined })
      .subscribe({
        next: (endpoint) => {
          this.busy.set(false);
          this.showCreate.set(false);
          this.newUrl = ''; this.newDescription = '';
          // The secret is returned exactly once — surface it prominently.
          if (endpoint.secret) this.revealedSecret.set(endpoint.secret);
          this.toast.success('Endpoint registered');
          this.loadEndpoints();
        },
        error: () => this.busy.set(false),
      });
  }

  toggleEndpoint(endpoint: WebhookEndpoint): void {
    this.api.updateEndpoint(endpoint.endpointId, { isActive: !endpoint.isActive }).subscribe({
      next: () => {
        this.toast.success(endpoint.isActive ? 'Endpoint disabled' : 'Endpoint enabled');
        this.loadEndpoints();
      },
      error: () => undefined,
    });
  }

  replay(delivery: WebhookDelivery): void {
    this.busy.set(true);
    this.api.replayDelivery(delivery.deliveryId).subscribe({
      next: () => {
        this.busy.set(false);
        this.toast.success('Replay queued', `${delivery.eventType} will be redelivered`);
        this.loadDeliveries(this.deliveries()?.pagination.page ?? 1);
      },
      error: () => this.busy.set(false),
    });
  }

  lastAttempt(delivery: WebhookDelivery) {
    return delivery.attempts?.length ? delivery.attempts[delivery.attempts.length - 1] : null;
  }

  truncate(url: string): string {
    return url.length > 42 ? `${url.slice(0, 42)}…` : url;
  }

  /** Render the retry ladder as human durations: "10s → 1m → 5m → …". */
  formatLadder(schedule: number[]): string {
    if (!schedule?.length) return '—';
    return schedule
      .map((ms) => (ms < 60_000 ? `${ms / 1000}s` : ms < 3_600_000 ? `${ms / 60_000}m` : `${ms / 3_600_000}h`))
      .join(' → ');
  }
}
