import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info' | 'warning';
  title: string;
  detail?: string;
  /** Echoed from the failing response so a user can quote it in a support ticket. */
  correlationId?: string;
}

/**
 * Transient notifications.
 *
 * Errors are shown here rather than swallowed, and carry the correlation id
 * from the failed response — which turns "it didn't work" into a single string
 * that finds the entire request in the server logs.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly items = signal<Toast[]>([]);
  readonly toasts = this.items.asReadonly();
  private nextId = 1;

  show(toast: Omit<Toast, 'id'>, timeoutMs = 6000): void {
    const id = this.nextId++;
    this.items.update((list) => [...list, { ...toast, id }]);
    // Errors linger longer — they usually need reading, not glancing at.
    const ttl = toast.kind === 'error' ? Math.max(timeoutMs, 9000) : timeoutMs;
    setTimeout(() => this.dismiss(id), ttl);
  }

  success(title: string, detail?: string): void { this.show({ kind: 'success', title, detail }); }
  error(title: string, detail?: string, correlationId?: string): void {
    this.show({ kind: 'error', title, detail, correlationId });
  }
  info(title: string, detail?: string): void { this.show({ kind: 'info', title, detail }); }
  warning(title: string, detail?: string): void { this.show({ kind: 'warning', title, detail }); }

  dismiss(id: number): void {
    this.items.update((list) => list.filter((toast) => toast.id !== id));
  }
}
