import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiResponse, Page, QueryParams } from '../models';

/**
 * Thin HTTP layer.
 *
 * Every endpoint returns the same `{ success, data, pagination, meta }`
 * envelope, so unwrapping it belongs here rather than in each feature service.
 * Components then receive plain domain objects and never know the envelope
 * exists.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBase;

  /** Drop null/undefined so an unset filter is simply absent from the query. */
  private toParams(query: QueryParams = {}): HttpParams {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === '') continue;
      params = params.set(key, String(value));
    }
    return params;
  }

  get<T>(path: string, query?: QueryParams): Observable<T> {
    return this.http
      .get<ApiResponse<T>>(`${this.base}${path}`, { params: this.toParams(query) })
      .pipe(map((res) => res.data));
  }

  /** A list endpoint returns items plus pagination; both are needed together. */
  getPage<T>(path: string, query?: QueryParams): Observable<Page<T>> {
    return this.http
      .get<ApiResponse<T[]>>(`${this.base}${path}`, { params: this.toParams(query) })
      .pipe(map((res) => ({
        items: res.data ?? [],
        pagination: res.pagination ?? {
          total: 0, page: 1, limit: 20, pages: 1, hasNext: false, hasPrev: false,
        },
      })));
  }

  /**
   * POST with an optional idempotency key.
   *
   * Mutating payment endpoints require one. Generating it client-side is what
   * makes a retry — whether by the user double-clicking or by an interceptor —
   * safe: the same key means the same logical operation.
   */
  post<T>(path: string, body: unknown, idempotencyKey?: string): Observable<T> {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined;
    return this.http
      .post<ApiResponse<T>>(`${this.base}${path}`, body, { headers })
      .pipe(map((res) => res.data));
  }

  patch<T>(path: string, body: unknown): Observable<T> {
    return this.http.patch<ApiResponse<T>>(`${this.base}${path}`, body).pipe(map((res) => res.data));
  }

  delete<T>(path: string): Observable<T> {
    return this.http.delete<ApiResponse<T>>(`${this.base}${path}`).pipe(map((res) => res.data));
  }

  /**
   * A fresh idempotency key.
   * `crypto.randomUUID` is available in every browser the console supports; the
   * fallback keeps it working over plain HTTP on a LAN, where the secure
   * context requirement would otherwise leave it undefined.
   */
  static newIdempotencyKey(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }
}
