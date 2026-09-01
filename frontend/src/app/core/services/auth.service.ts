import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Observable, map, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse, AuthResult, Role, User } from '../models';

const ACCESS_KEY = 'payflux.access';
const REFRESH_KEY = 'payflux.refresh';
const USER_KEY = 'payflux.user';

/**
 * Authentication state.
 *
 * Signals rather than BehaviorSubjects: the auth state is read synchronously
 * all over the template tree (nav visibility, role gating), and a signal reads
 * without a subscription and without an `async` pipe in every component.
 *
 * ── On token storage ──────────────────────────────────────────────────────
 * Tokens live in `localStorage`, which is readable by any script on the origin
 * and therefore vulnerable to XSS. The genuinely safe design is an httpOnly,
 * SameSite=Strict cookie, which JavaScript cannot read at all. That is the
 * right choice for a production deployment; it is noted here rather than left
 * implicit, because "we used localStorage" should always be a decision rather
 * than an accident. The access token's 15-minute lifetime and the server-side
 * `tokenVersion` revocation bound the damage.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly base = environment.apiBase;

  private readonly userSignal = signal<User | null>(this.readStoredUser());

  readonly user = this.userSignal.asReadonly();
  readonly isAuthenticated = computed(() => this.userSignal() !== null);
  readonly role = computed<Role | null>(() => this.userSignal()?.role ?? null);
  readonly merchant = computed(() => this.userSignal()?.merchant ?? null);
  /** SUPPORT is read-only platform-wide; the UI hides write affordances. */
  readonly canWrite = computed(() => {
    const role = this.role();
    return role === 'ADMIN' || role === 'MERCHANT';
  });

  private readStoredUser(): User | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as User) : null;
    } catch {
      // Corrupted storage must not brick the app on load.
      return null;
    }
  }

  get accessToken(): string | null {
    try { return localStorage.getItem(ACCESS_KEY); } catch { return null; }
  }

  get refreshToken(): string | null {
    try { return localStorage.getItem(REFRESH_KEY); } catch { return null; }
  }

  login(email: string, password: string): Observable<AuthResult> {
    return this.http
      .post<ApiResponse<AuthResult>>(`${this.base}/auth/login`, { email, password })
      .pipe(
        tap((res) => this.persist(res.data)),
        // Callers want the result, not the transport envelope.
        map((res) => res.data),
      );
  }

  /** Exchange the refresh token for a new pair. Used by the auth interceptor. */
  refresh(): Observable<ApiResponse<AuthResult>> {
    return this.http
      .post<ApiResponse<AuthResult>>(`${this.base}/auth/refresh`, { refreshToken: this.refreshToken })
      .pipe(tap((res) => this.persist(res.data)));
  }

  private persist(result: AuthResult): void {
    try {
      localStorage.setItem(ACCESS_KEY, result.accessToken);
      localStorage.setItem(REFRESH_KEY, result.refreshToken);
      localStorage.setItem(USER_KEY, JSON.stringify(result.user));
    } catch {
      // Private browsing can reject writes; the session still works in-memory.
    }
    this.userSignal.set(result.user);
  }

  /**
   * Clear local state and revoke server-side.
   * The local clear happens first and unconditionally: a user clicking "sign
   * out" must end up signed out even if the network call fails.
   */
  logout(navigate = true): void {
    const token = this.accessToken;
    this.clear();
    if (token) {
      this.http.post(`${this.base}/auth/logout`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      }).subscribe({ error: () => undefined });
    }
    if (navigate) this.router.navigate(['/login']);
  }

  clear(): void {
    try {
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(USER_KEY);
    } catch { /* ignore */ }
    this.userSignal.set(null);
  }

  hasRole(...roles: Role[]): boolean {
    const current = this.role();
    return current !== null && roles.includes(current);
  }
}
