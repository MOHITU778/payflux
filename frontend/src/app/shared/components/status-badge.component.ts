import { Component, Input, computed, signal } from '@angular/core';

/**
 * Status pill.
 *
 * Colour alone never carries the meaning — the label is always present — so the
 * component remains readable for users with colour vision deficiency and in a
 * printed export.
 */
@Component({
  selector: 'pf-status',
  standalone: true,
  template: `<span class="badge badge--{{ tone() }}">{{ label() }}</span>`,
})
export class StatusBadgeComponent {
  private readonly statusSignal = signal<string>('');

  @Input({ required: true })
  set status(value: string) { this.statusSignal.set(value ?? ''); }

  readonly label = computed(() => this.statusSignal().replace(/_/g, ' '));

  readonly tone = computed(() => {
    switch (this.statusSignal()) {
      case 'SUCCESS': case 'SETTLED': case 'DELIVERED': case 'ALLOW': case 'BALANCED': case 'ACTIVE':
        return 'success';
      case 'FAILED': case 'BLOCK': case 'DEAD_LETTERED': case 'DISCREPANCY_FOUND': case 'CHARGEBACK':
        return 'danger';
      case 'PENDING': case 'PROCESSING': case 'QUEUED': case 'RETRYING': case 'AUTHORIZED':
        return 'warning';
      case 'REVIEW': case 'PARTIALLY_REFUNDED':
        return 'info';
      case 'REFUNDED':
        return 'accent';
      default:
        return 'neutral';
    }
  });
}
