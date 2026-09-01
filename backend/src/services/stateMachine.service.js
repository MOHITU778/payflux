'use strict';

const {
  PAYMENT_STATUS, PAYMENT_TRANSITIONS, TERMINAL_PAYMENT_STATUSES, REFUND_STATUS,
} = require('../constants');
const { InvalidStateTransitionError } = require('../errors');

/**
 * Payment state machine.
 *
 * Centralising the transition table means the rule "a SUCCESS payment can
 * never go back to PENDING" is stated once and enforced everywhere — the API,
 * the acquirer webhook handler and the retry worker all funnel through here.
 * Scattering `if (status === …)` checks across services is how a payment ends
 * up refunded twice.
 *
 * The machine is deliberately *pure*: it decides, it does not persist. The
 * repository's compare-and-swap performs the write, so validity and atomicity
 * are separate, independently testable concerns.
 */
class StateMachineService {
  constructor(transitions = PAYMENT_TRANSITIONS) {
    this.transitions = transitions;
  }

  /** @returns {string[]} states reachable in one step from `status`. */
  allowedFrom(status) {
    return this.transitions[status] ?? [];
  }

  /** @returns {boolean} whether `from → to` is a legal edge. */
  canTransition(from, to) {
    return this.allowedFrom(from).includes(to);
  }

  /**
   * Assert a transition is legal.
   * @throws {InvalidStateTransitionError}
   */
  assertTransition(from, to, entity = 'Payment') {
    if (from === to) {
      // Self-transitions are not edges. Callers that legitimately want "already
      // in the target state" semantics should check `isTerminal`/equality
      // first — silently allowing them would mask duplicate processing.
      throw new InvalidStateTransitionError(from, to, entity);
    }
    if (!this.canTransition(from, to)) throw new InvalidStateTransitionError(from, to, entity);
    return true;
  }

  isTerminal(status) {
    return TERMINAL_PAYMENT_STATUSES.includes(status);
  }

  /** A payment that has reached a terminal state can never be acted on again. */
  assertNotTerminal(status, action) {
    if (this.isTerminal(status)) {
      throw new InvalidStateTransitionError(status, action, 'Payment');
    }
  }

  /**
   * Every state reachable from `status`, for UI affordances ("can this be
   * refunded?") without duplicating the table in the frontend.
   */
  reachableFrom(status) {
    const seen = new Set();
    const queue = [...this.allowedFrom(status)];
    while (queue.length) {
      const next = queue.shift();
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...this.allowedFrom(next));
    }
    return [...seen];
  }

  /** Machine-readable description of the graph, exposed via the API for docs/UI. */
  describe() {
    return Object.entries(this.transitions).map(([state, next]) => ({
      state,
      transitions: next,
      terminal: this.isTerminal(state),
    }));
  }
}

/**
 * Refunds run a simpler linear machine, but the same discipline applies:
 * a SUCCESS refund must never be re-processed by a redelivered job.
 */
const REFUND_TRANSITIONS = Object.freeze({
  [REFUND_STATUS.PENDING]: [REFUND_STATUS.PROCESSING, REFUND_STATUS.FAILED],
  [REFUND_STATUS.PROCESSING]: [REFUND_STATUS.SUCCESS, REFUND_STATUS.FAILED],
  [REFUND_STATUS.SUCCESS]: [],
  [REFUND_STATUS.FAILED]: [],
});

const paymentStateMachine = new StateMachineService(PAYMENT_TRANSITIONS);
const refundStateMachine = new StateMachineService(REFUND_TRANSITIONS);

module.exports = {
  StateMachineService,
  paymentStateMachine,
  refundStateMachine,
  PAYMENT_STATUS,
  REFUND_TRANSITIONS,
};
