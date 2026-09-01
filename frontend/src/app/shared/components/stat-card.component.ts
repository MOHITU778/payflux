import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * A single headline metric.
 *
 * The value is the largest element by a wide margin: on an operations
 * dashboard the number is what gets read, and the label only needs to be
 * legible enough to identify it.
 */
@Component({
  selector: 'pf-stat',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="stat" [class.stat--loading]="loading">
      <div class="stat-label">{{ label }}</div>
      @if (loading) {
        <div class="skeleton stat-skeleton"></div>
      } @else {
        <div class="stat-value num" [style.color]="accent || null">
          @if (prefix) { <span class="stat-prefix">{{ prefix }}</span> }{{ value }}
        </div>
        @if (hint) { <div class="stat-hint">{{ hint }}</div> }
      }
    </div>
  `,
  styles: [`
    .stat {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 18px;
      min-width: 0;
    }
    .stat-label {
      font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase;
      color: var(--text-dim); margin-bottom: 10px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .stat-value {
      font-size: 26px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.15;
      overflow: hidden; text-overflow: ellipsis;
    }
    .stat-prefix { font-size: 17px; color: var(--text-muted); margin-right: 2px; font-weight: 500; }
    .stat-hint { font-size: 11px; color: var(--text-dim); margin-top: 6px; }
    .stat-skeleton { height: 30px; width: 70%; }
  `],
})
export class StatCardComponent {
  @Input({ required: true }) label = '';
  @Input() value: string | number = '—';
  @Input() prefix = '';
  @Input() hint = '';
  /** Reserved for values that genuinely need emphasis (a failure count). */
  @Input() accent = '';
  @Input() loading = false;
}
