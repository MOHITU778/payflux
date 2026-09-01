import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

/**
 * Sign-in screen.
 *
 * The error message shown is whatever the server returned, unmodified: the
 * server deliberately gives the same answer for "wrong password" and "no such
 * user", and paraphrasing it here would risk re-introducing the user
 * enumeration that the API is careful to avoid.
 */
@Component({
  selector: 'pf-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  template: `
    <div class="auth">
      <div class="auth-panel">
        <div class="auth-brand">
          <span class="mark" aria-hidden="true">⚡</span>
          <div>
            <div class="mark-name">PayFlux</div>
            <div class="mark-sub">Operations Console</div>
          </div>
        </div>

        <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <div class="field">
            <label class="label" for="email">Email</label>
            <input id="email" class="input" type="email" formControlName="email"
                   autocomplete="username" placeholder="you@company.com" />
            @if (touched('email')) {
              <div class="field-error">A valid email address is required</div>
            }
          </div>

          <div class="field">
            <label class="label" for="password">Password</label>
            <input id="password" class="input" type="password" formControlName="password"
                   autocomplete="current-password" placeholder="••••••••••••" />
            @if (touched('password')) {
              <div class="field-error">Password is required</div>
            }
          </div>

          @if (error()) {
            <div class="auth-error" role="alert">{{ error() }}</div>
          }

          <button class="btn btn--primary auth-submit" type="submit"
                  [disabled]="submitting() || form.invalid">
            @if (submitting()) { <span class="spinner"></span> Signing in… }
            @else { Sign in }
          </button>
        </form>

        <div class="auth-hint">
          <div class="hint-title">Demo accounts</div>
          <button class="hint-row" type="button" (click)="fill('admin@payflux.io')">
            <span class="badge badge--accent">ADMIN</span>
            <span class="mono tiny">admin&#64;payflux.io</span>
          </button>
          <button class="hint-row" type="button" (click)="fill('merchant@nimbusretail.example')">
            <span class="badge badge--success">MERCHANT</span>
            <span class="mono tiny">merchant&#64;nimbusretail.example</span>
          </button>
          <button class="hint-row" type="button" (click)="fill('support@payflux.io')">
            <span class="badge badge--info">SUPPORT</span>
            <span class="mono tiny">support&#64;payflux.io</span>
          </button>
          <div class="tiny dim hint-pass">Password for all: <code class="mono">PayFlux#2024</code></div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .auth {
      min-height: 100vh;
      display: grid; place-items: center;
      padding: 24px;
      background:
        radial-gradient(900px 500px at 20% -10%, rgba(79,140,255,.10), transparent 60%),
        radial-gradient(700px 400px at 90% 110%, rgba(41,192,136,.07), transparent 60%),
        var(--bg);
    }
    .auth-panel {
      width: 100%; max-width: 396px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 30px;
      box-shadow: var(--shadow);
    }
    .auth-brand { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }
    .mark {
      font-size: 20px; width: 40px; height: 40px; border-radius: 10px;
      background: var(--accent-soft); display: grid; place-items: center;
    }
    .mark-name { font-size: 17px; font-weight: 700; letter-spacing: -0.02em; }
    .mark-sub { font-size: 11px; color: var(--text-dim); }

    .auth-error {
      background: var(--danger-soft); color: var(--danger);
      border-radius: var(--radius-sm); padding: 10px 12px;
      font-size: 12px; margin-bottom: 14px;
    }
    .auth-submit { width: 100%; padding: 10px; margin-top: 4px; }

    .auth-hint {
      margin-top: 24px; padding-top: 18px;
      border-top: 1px solid var(--border);
    }
    .hint-title {
      font-size: 10px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase;
      color: var(--text-dim); margin-bottom: 10px;
    }
    .hint-row {
      display: flex; align-items: center; gap: 9px; width: 100%;
      padding: 6px 8px; margin-bottom: 4px;
      background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
      color: var(--text-muted); cursor: pointer; text-align: left; font: inherit;
    }
    .hint-row:hover { background: var(--surface-2); border-color: var(--border); }
    .hint-pass { margin-top: 8px; }
    code { background: var(--surface-3); padding: 1px 5px; border-radius: 3px; }
  `],
})
export class LoginComponent {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  touched(control: 'email' | 'password'): boolean {
    const field = this.form.controls[control];
    return field.invalid && (field.dirty || field.touched);
  }

  /** Fill a demo account so a reviewer can sign in without typing. */
  fill(email: string): void {
    this.form.patchValue({ email, password: 'PayFlux#2024' });
  }

  submit(): void {
    if (this.form.invalid || this.submitting()) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.error.set(null);

    const { email, password } = this.form.getRawValue();
    this.auth.login(email, password).subscribe({
      next: () => {
        // Return the user to wherever the guard intercepted them.
        const redirect = this.route.snapshot.queryParamMap.get('redirect') ?? '/dashboard';
        this.router.navigateByUrl(redirect);
      },
      error: (err: { error?: { error?: { message?: string } } }) => {
        this.submitting.set(false);
        this.error.set(err?.error?.error?.message ?? 'Unable to sign in. Please try again.');
      },
    });
  }
}
