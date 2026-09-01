'use strict';

const {
  paymentStateMachine, refundStateMachine, StateMachineService,
} = require('../../src/services/stateMachine.service');
const { PAYMENT_STATUS, REFUND_STATUS } = require('../../src/constants');
const { InvalidStateTransitionError } = require('../../src/errors');

describe('payment state machine', () => {
  it('permits the happy path', () => {
    expect(paymentStateMachine.canTransition(PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PROCESSING)).toBe(true);
    expect(paymentStateMachine.canTransition(PAYMENT_STATUS.PROCESSING, PAYMENT_STATUS.SUCCESS)).toBe(true);
    expect(paymentStateMachine.canTransition(PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.REFUNDED)).toBe(true);
  });

  it('refuses to resurrect a terminal payment', () => {
    for (const terminal of [PAYMENT_STATUS.FAILED, PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REFUNDED]) {
      expect(paymentStateMachine.allowedFrom(terminal)).toEqual([]);
      expect(paymentStateMachine.isTerminal(terminal)).toBe(true);
    }
  });

  it('refuses to cancel a captured payment — the money has already moved', () => {
    expect(paymentStateMachine.canTransition(PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.CANCELLED)).toBe(false);
    expect(() => paymentStateMachine.assertTransition(PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.CANCELLED))
      .toThrow(InvalidStateTransitionError);
  });

  it('refuses to jump straight from PENDING to SUCCESS, skipping authorisation', () => {
    expect(paymentStateMachine.canTransition(PAYMENT_STATUS.PENDING, PAYMENT_STATUS.SUCCESS)).toBe(false);
  });

  it('treats a self-transition as illegal so duplicate processing is visible', () => {
    expect(() => paymentStateMachine.assertTransition(PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.SUCCESS))
      .toThrow(InvalidStateTransitionError);
  });

  it('carries both ends of the attempted transition in the error', () => {
    try {
      paymentStateMachine.assertTransition(PAYMENT_STATUS.REFUNDED, PAYMENT_STATUS.SUCCESS);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
      expect(err.details).toEqual({
        from: PAYMENT_STATUS.REFUNDED, to: PAYMENT_STATUS.SUCCESS, entity: 'Payment',
      });
      expect(err.status).toBe(409);
    }
  });

  it('allows repeated partial refunds but never leaves REFUNDED', () => {
    expect(paymentStateMachine.canTransition(
      PAYMENT_STATUS.PARTIALLY_REFUNDED, PAYMENT_STATUS.PARTIALLY_REFUNDED,
    )).toBe(true);
    expect(paymentStateMachine.allowedFrom(PAYMENT_STATUS.REFUNDED)).toEqual([]);
  });

  it('computes the full reachable set for UI affordances', () => {
    const reachable = paymentStateMachine.reachableFrom(PAYMENT_STATUS.PENDING);
    expect(reachable).toEqual(expect.arrayContaining([
      PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.FAILED, PAYMENT_STATUS.REFUNDED,
    ]));
  });

  it('describes the graph for publication to clients', () => {
    const described = paymentStateMachine.describe();
    expect(described).toHaveLength(Object.keys(PAYMENT_STATUS).length);
    expect(described.find((s) => s.state === PAYMENT_STATUS.FAILED).terminal).toBe(true);
  });

  it('is a pure decision function — no persistence side effects', () => {
    const machine = new StateMachineService({ A: ['B'], B: [] });
    expect(machine.canTransition('A', 'B')).toBe(true);
    expect(machine.canTransition('B', 'A')).toBe(false);
    expect(machine.allowedFrom('UNKNOWN')).toEqual([]);
  });
});

describe('refund state machine', () => {
  it('runs a linear lifecycle', () => {
    expect(refundStateMachine.canTransition(REFUND_STATUS.PENDING, REFUND_STATUS.PROCESSING)).toBe(true);
    expect(refundStateMachine.canTransition(REFUND_STATUS.PROCESSING, REFUND_STATUS.SUCCESS)).toBe(true);
  });

  it('never re-processes a settled refund — the redelivery guard', () => {
    expect(refundStateMachine.allowedFrom(REFUND_STATUS.SUCCESS)).toEqual([]);
    expect(() => refundStateMachine.assertTransition(
      REFUND_STATUS.SUCCESS, REFUND_STATUS.PROCESSING, 'Refund',
    )).toThrow(InvalidStateTransitionError);
  });
});
