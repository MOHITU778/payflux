import { Routes } from '@angular/router';
import { authGuard, guestGuard, roleGuard } from './core/guards/auth.guard';

/**
 * Route table.
 *
 * Every feature is lazily loaded via `loadComponent`, so the initial bundle
 * carries only the shell and the login screen. A merchant who never opens the
 * ledger never downloads it.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },

  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Sign in · PayFlux',
    loadComponent: () => import('./features/auth/login.component').then((m) => m.LoginComponent),
  },

  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shared/components/shell.component').then((m) => m.ShellComponent),
    children: [
      {
        path: 'dashboard',
        title: 'Dashboard · PayFlux',
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },
      {
        path: 'transactions',
        title: 'Transactions · PayFlux',
        loadComponent: () =>
          import('./features/transactions/transactions.component').then((m) => m.TransactionsComponent),
      },
      {
        path: 'transactions/:paymentId',
        title: 'Payment · PayFlux',
        loadComponent: () =>
          import('./features/transactions/payment-detail.component').then((m) => m.PaymentDetailComponent),
      },
      {
        path: 'fraud',
        title: 'Risk · PayFlux',
        loadComponent: () => import('./features/fraud/fraud.component').then((m) => m.FraudComponent),
      },
      {
        path: 'settlements',
        title: 'Settlements · PayFlux',
        loadComponent: () =>
          import('./features/settlements/settlements.component').then((m) => m.SettlementsComponent),
      },
      {
        path: 'webhooks',
        title: 'Webhooks · PayFlux',
        loadComponent: () =>
          import('./features/webhooks/webhooks.component').then((m) => m.WebhooksComponent),
      },
      {
        // The ledger exposes platform-wide financial position, so it is
        // restricted to staff. The guard mirrors the server's own rule.
        path: 'ledger',
        canActivate: [roleGuard('ADMIN', 'SUPPORT')],
        title: 'Ledger · PayFlux',
        loadComponent: () => import('./features/ledger/ledger.component').then((m) => m.LedgerComponent),
      },
    ],
  },

  { path: '**', redirectTo: 'dashboard' },
];
