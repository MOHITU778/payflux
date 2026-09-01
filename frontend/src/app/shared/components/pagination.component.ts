import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Pagination } from '../../core/models';

/** Page navigation for every list view. */
@Component({
  selector: 'pf-pagination',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (pagination) {
      <div class="pager">
        <div class="pager-info small dim">
          Showing
          <span class="num">{{ rangeStart }}</span>–<span class="num">{{ rangeEnd }}</span>
          of <span class="num strong">{{ pagination.total | number }}</span>
        </div>
        <div class="spacer"></div>
        <div class="row">
          <button class="btn btn--sm" [disabled]="!pagination.hasPrev" (click)="go(1)"
                  aria-label="First page">« First</button>
          <button class="btn btn--sm" [disabled]="!pagination.hasPrev" (click)="go(pagination.page - 1)"
                  aria-label="Previous page">‹ Prev</button>
          <span class="pager-current small">
            Page <span class="num strong">{{ pagination.page }}</span>
            of <span class="num">{{ pagination.pages }}</span>
          </span>
          <button class="btn btn--sm" [disabled]="!pagination.hasNext" (click)="go(pagination.page + 1)"
                  aria-label="Next page">Next ›</button>
          <button class="btn btn--sm" [disabled]="!pagination.hasNext" (click)="go(pagination.pages)"
                  aria-label="Last page">Last »</button>
        </div>
      </div>
    }
  `,
  styles: [`
    .pager {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 12px 16px; border-top: 1px solid var(--border);
    }
    .pager-current { padding: 0 8px; color: var(--text-muted); white-space: nowrap; }
  `],
})
export class PaginationComponent {
  @Input() pagination: Pagination | null = null;
  @Output() pageChange = new EventEmitter<number>();

  get rangeStart(): number {
    if (!this.pagination || this.pagination.total === 0) return 0;
    return (this.pagination.page - 1) * this.pagination.limit + 1;
  }

  get rangeEnd(): number {
    if (!this.pagination) return 0;
    return Math.min(this.pagination.page * this.pagination.limit, this.pagination.total);
  }

  go(page: number): void {
    if (!this.pagination) return;
    const clamped = Math.min(Math.max(1, page), this.pagination.pages);
    if (clamped !== this.pagination.page) this.pageChange.emit(clamped);
  }
}
