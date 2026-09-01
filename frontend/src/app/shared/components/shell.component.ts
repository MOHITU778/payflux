import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

interface NavItem { path: string; label: string; icon: string; roles?: string[]; }

/**
 * Authenticated application shell: sidebar navigation, top bar, outlet.
 *
 * Navigation entries are filtered by role so a merchant never sees a link to a
 * page the server would refuse — showing an option that always 403s is worse
 * than not showing it.
 */
@Component({
  selector: 'pf-shell',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="shell" [class.shell--collapsed]="collapsed()">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true">⚡</span>
          <span class="brand-name">PayFlux</span>
        </div>

        <nav class="nav" aria-label="Main">
          @for (item of visibleNav(); track item.path) {
            <a class="nav-item" [routerLink]="item.path" routerLinkActive="nav-item--active"
               [routerLinkActiveOptions]="{ exact: false }">
              <span class="nav-icon" aria-hidden="true">{{ item.icon }}</span>
              <span class="nav-label">{{ item.label }}</span>
            </a>
          }
        </nav>

        <div class="sidebar-foot">
          <div class="env-pill">
            <span class="dot"></span>
            <span class="tiny">API connected</span>
          </div>
        </div>
      </aside>

      <div class="main">
        <header class="topbar">
          <button class="btn btn--ghost btn--sm" (click)="toggle()"
                  [attr.aria-label]="collapsed() ? 'Expand navigation' : 'Collapse navigation'">☰</button>

          <div class="scope">
            @if (merchant(); as m) {
              <span class="scope-label tiny dim">MERCHANT</span>
              <span class="scope-value">{{ m.name }}</span>
              <span class="badge badge--neutral mono">{{ m.merchantId }}</span>
            } @else {
              <span class="scope-label tiny dim">SCOPE</span>
              <span class="scope-value">All merchants</span>
            }
          </div>

          <div class="spacer"></div>

          <button class="btn btn--ghost btn--sm" (click)="toggleTheme()"
                  [attr.aria-label]="'Switch to ' + (theme() === 'dark' ? 'light' : 'dark') + ' theme'">
            {{ theme() === 'dark' ? '☀' : '☾' }}
          </button>

          <div class="user">
            <div class="user-meta">
              <div class="user-name">{{ user()?.name }}</div>
              <div class="user-role tiny dim">{{ user()?.role }}</div>
            </div>
            <div class="avatar" aria-hidden="true">{{ initials() }}</div>
          </div>

          <button class="btn btn--sm" (click)="signOut()">Sign out</button>
        </header>

        <main class="content">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
  styles: [`
    .shell { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
    .shell--collapsed { grid-template-columns: 64px 1fr; }
    .shell--collapsed .nav-label,
    .shell--collapsed .brand-name,
    .shell--collapsed .sidebar-foot { display: none; }
    .shell--collapsed .nav-item { justify-content: center; }

    .sidebar {
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex; flex-direction: column;
      position: sticky; top: 0; height: 100vh;
    }
    .brand {
      display: flex; align-items: center; gap: 9px;
      padding: 18px 18px 20px; font-weight: 700; font-size: 15px; letter-spacing: -0.02em;
    }
    .brand-mark { font-size: 17px; }

    .nav { display: flex; flex-direction: column; gap: 2px; padding: 0 10px; flex: 1; }
    .nav-item {
      display: flex; align-items: center; gap: 11px;
      padding: 9px 11px; border-radius: var(--radius-sm);
      color: var(--text-muted); font-size: 13px; font-weight: 500;
      text-decoration: none;
      transition: background .12s, color .12s;
    }
    .nav-item:hover { background: var(--surface-2); color: var(--text); text-decoration: none; }
    .nav-item--active { background: var(--accent-soft); color: var(--accent); }
    .nav-icon { font-size: 14px; width: 17px; text-align: center; }

    .sidebar-foot { padding: 14px 18px; border-top: 1px solid var(--border); }
    .env-pill { display: flex; align-items: center; gap: 7px; color: var(--text-dim); }
    .dot {
      width: 6px; height: 6px; border-radius: 50%; background: var(--success);
      box-shadow: 0 0 0 3px var(--success-soft);
    }

    .main { display: flex; flex-direction: column; min-width: 0; }
    .topbar {
      display: flex; align-items: center; gap: 14px;
      padding: 12px 22px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      position: sticky; top: 0; z-index: 20;
    }
    .scope { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .scope-label { letter-spacing: .06em; }
    .scope-value { font-size: 13px; font-weight: 600; white-space: nowrap; }

    .user { display: flex; align-items: center; gap: 9px; }
    .user-meta { text-align: right; line-height: 1.25; }
    .user-name { font-size: 12px; font-weight: 600; }
    .avatar {
      width: 30px; height: 30px; border-radius: 50%;
      background: var(--accent-soft); color: var(--accent);
      display: grid; place-items: center;
      font-size: 11px; font-weight: 700;
    }

    .content { padding: 22px; flex: 1; min-width: 0; }

    @media (max-width: 860px) {
      .shell { grid-template-columns: 64px 1fr; }
      .nav-label, .brand-name, .sidebar-foot, .user-meta { display: none; }
      .nav-item { justify-content: center; }
      .content { padding: 14px; }
    }
  `],
})
export class ShellComponent {
  private readonly auth = inject(AuthService);

  readonly user = this.auth.user;
  readonly merchant = this.auth.merchant;
  readonly collapsed = signal(false);
  readonly theme = signal<'dark' | 'light'>(this.readTheme());

  private readonly navItems: NavItem[] = [
    { path: '/dashboard', label: 'Dashboard', icon: '▤' },
    { path: '/transactions', label: 'Transactions', icon: '⇄' },
    { path: '/fraud', label: 'Risk', icon: '⚠' },
    { path: '/settlements', label: 'Settlements', icon: '⇩' },
    { path: '/webhooks', label: 'Webhooks', icon: '⚯' },
    { path: '/ledger', label: 'Ledger', icon: '≡', roles: ['ADMIN', 'SUPPORT'] },
  ];

  visibleNav(): NavItem[] {
    const role = this.auth.role();
    return this.navItems.filter((item) => !item.roles || (role && item.roles.includes(role)));
  }

  initials(): string {
    const name = this.user()?.name ?? '';
    return name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase() || '?';
  }

  toggle(): void { this.collapsed.update((value) => !value); }

  private readTheme(): 'dark' | 'light' {
    try {
      return (localStorage.getItem('payflux.theme') as 'dark' | 'light') ?? 'dark';
    } catch { return 'dark'; }
  }

  toggleTheme(): void {
    const next = this.theme() === 'dark' ? 'light' : 'dark';
    this.theme.set(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('payflux.theme', next); } catch { /* private mode */ }
  }

  signOut(): void { this.auth.logout(); }

  constructor() {
    // Apply the stored preference on first paint of the shell.
    document.documentElement.setAttribute('data-theme', this.theme());
  }
}
