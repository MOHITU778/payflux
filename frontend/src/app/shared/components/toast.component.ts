import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'pf-toasts',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- aria-live so a screen reader announces errors that appear without a
         focus change; 'polite' avoids interrupting the user mid-sentence. -->
    <div class="toast-host" role="status" aria-live="polite">
      @for (toast of toasts(); track toast.id) {
        <div class="toast toast--{{ toast.kind }}">
          <div class="toast-body">
            <div class="toast-title">{{ toast.title }}</div>
            @if (toast.detail) { <div class="toast-detail">{{ toast.detail }}</div> }
            @if (toast.correlationId) {
              <div class="toast-trace mono" title="Quote this when contacting support">
                {{ toast.correlationId }}
              </div>
            }
          </div>
          <button class="toast-close" (click)="dismiss(toast.id)" aria-label="Dismiss">×</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .toast-host {
      position: fixed; top: 16px; right: 16px; z-index: 1000;
      display: flex; flex-direction: column; gap: 10px;
      max-width: min(420px, calc(100vw - 32px));
      pointer-events: none;
    }
    .toast {
      pointer-events: auto;
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-left-width: 3px;
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow);
      animation: slide-in .2s ease-out;
    }
    @keyframes slide-in { from { opacity: 0; transform: translateX(12px); } }
    .toast--success { border-left-color: var(--success); }
    .toast--error   { border-left-color: var(--danger); }
    .toast--warning { border-left-color: var(--warning); }
    .toast--info    { border-left-color: var(--accent); }
    .toast-body { flex: 1; min-width: 0; }
    .toast-title { font-size: 13px; font-weight: 600; }
    .toast-detail { font-size: 12px; color: var(--text-muted); margin-top: 3px; word-break: break-word; }
    .toast-trace { font-size: 10px; color: var(--text-dim); margin-top: 6px; }
    .toast-close {
      background: none; border: none; color: var(--text-dim);
      font-size: 18px; line-height: 1; cursor: pointer; padding: 0 2px;
    }
    .toast-close:hover { color: var(--text); }
  `],
})
export class ToastContainerComponent {
  private readonly service = inject(ToastService);
  readonly toasts = this.service.toasts;
  dismiss(id: number): void { this.service.dismiss(id); }
}
