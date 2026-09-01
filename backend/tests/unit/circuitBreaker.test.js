'use strict';

const { CircuitBreaker, STATE } = require('../../src/services/circuitBreaker.service');
const { CircuitOpenError } = require('../../src/errors');

const fail = () => { throw new Error('dependency down'); };
const succeed = async () => 'ok';

describe('circuit breaker', () => {
  it('stays closed while calls succeed', async () => {
    const breaker = new CircuitBreaker('t1', { failureThreshold: 3 });
    await breaker.execute(succeed);
    expect(breaker.state).toBe(STATE.CLOSED);
  });

  it('opens after the failure threshold', async () => {
    const breaker = new CircuitBreaker('t2', { failureThreshold: 3 });
    for (let i = 0; i < 3; i += 1) await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.state).toBe(STATE.OPEN);
  });

  it('fails fast without invoking the dependency once open', async () => {
    const breaker = new CircuitBreaker('t3', { failureThreshold: 1, timeoutMs: 10_000 });
    await expect(breaker.execute(fail)).rejects.toThrow();

    const spy = jest.fn(succeed);
    await expect(breaker.execute(spy)).rejects.toThrow(CircuitOpenError);
    // The whole point: the downstream call is never attempted.
    expect(spy).not.toHaveBeenCalled();
  });

  it('resets the consecutive-failure count on success', async () => {
    const breaker = new CircuitBreaker('t4', { failureThreshold: 3 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    await expect(breaker.execute(fail)).rejects.toThrow();
    await breaker.execute(succeed);
    expect(breaker.failures).toBe(0);
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.state).toBe(STATE.CLOSED); // not 3 *consecutive* failures
  });

  it('probes in half-open after the cooldown and closes on enough successes', async () => {
    const breaker = new CircuitBreaker('t5', {
      failureThreshold: 1, successThreshold: 2, timeoutMs: 30,
    });
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.state).toBe(STATE.OPEN);

    await new Promise((r) => setTimeout(r, 50));
    await breaker.execute(succeed);
    expect(breaker.state).toBe(STATE.HALF_OPEN); // one success is not enough
    await breaker.execute(succeed);
    expect(breaker.state).toBe(STATE.CLOSED);
  });

  it('re-opens immediately when a half-open probe fails', async () => {
    const breaker = new CircuitBreaker('t6', {
      failureThreshold: 1, successThreshold: 2, timeoutMs: 30,
    });
    await expect(breaker.execute(fail)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.state).toBe(STATE.OPEN);
  });

  it('releases the half-open probe slot when a probe settles', async () => {
    // Regression: leaving `halfOpenCalls` incremented pinned the breaker
    // half-open forever whenever successThreshold > halfOpenMaxCalls.
    const breaker = new CircuitBreaker('t7', {
      failureThreshold: 1, successThreshold: 3, timeoutMs: 20, halfOpenMaxCalls: 1,
    });
    await expect(breaker.execute(fail)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 40));
    await breaker.execute(succeed);
    await breaker.execute(succeed);
    await breaker.execute(succeed);
    expect(breaker.state).toBe(STATE.CLOSED);
  });

  it('does not count a 4xx business rejection against the circuit', async () => {
    const breaker = new CircuitBreaker('t8', { failureThreshold: 2 });
    const declined = () => {
      const err = new Error('insufficient funds');
      err.status = 402;
      throw err;
    };
    for (let i = 0; i < 5; i += 1) await expect(breaker.execute(declined)).rejects.toThrow();
    // Customers having no money is not a dependency outage.
    expect(breaker.state).toBe(STATE.CLOSED);
  });

  it('reports retryAfterMs while open', async () => {
    const breaker = new CircuitBreaker('t9', { failureThreshold: 1, timeoutMs: 5000 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.retryAfterMs).toBeGreaterThan(0);
    expect(breaker.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it('exposes a snapshot for health reporting', async () => {
    const breaker = new CircuitBreaker('t10', { failureThreshold: 1 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    const snapshot = breaker.snapshot();
    expect(snapshot).toMatchObject({ name: 't10', state: STATE.OPEN });
    expect(snapshot.stats.failures).toBe(1);
  });
});
