'use strict';

const money = require('../../src/utils/money');
const { ValidationError } = require('../../src/errors');

/**
 * Money is the one place where a rounding bug becomes a financial defect, so
 * these tests target the exact cases where floating point would betray us.
 */
describe('money', () => {
  describe('toMajorString', () => {
    it('formats minor units with the correct decimal placement', () => {
      expect(money.toMajorString(125050, 'INR')).toBe('1250.50');
      expect(money.toMajorString(1, 'INR')).toBe('0.01');
      expect(money.toMajorString(0, 'USD')).toBe('0.00');
      expect(money.toMajorString(100, 'USD')).toBe('1.00');
    });

    it('handles negative amounts (refund and reversal legs)', () => {
      expect(money.toMajorString(-4999, 'EUR')).toBe('-49.99');
    });

    it('pads amounts smaller than one major unit', () => {
      expect(money.toMajorString(5, 'GBP')).toBe('0.05');
    });
  });

  describe('fromMajor', () => {
    it('parses decimal strings without floating-point error', () => {
      expect(money.fromMajor('1250.50', 'INR')).toBe(125050);
      // 0.1 + 0.2 !== 0.3 in IEEE-754; string parsing sidesteps that entirely.
      expect(money.fromMajor('0.10', 'USD') + money.fromMajor('0.20', 'USD'))
        .toBe(money.fromMajor('0.30', 'USD'));
    });

    it('pads a short fractional part', () => {
      expect(money.fromMajor('12.5', 'INR')).toBe(1250);
      expect(money.fromMajor('12', 'INR')).toBe(1200);
    });

    it('rejects more precision than the currency supports', () => {
      expect(() => money.fromMajor('12.345', 'INR')).toThrow(ValidationError);
    });

    it('rejects malformed input', () => {
      expect(() => money.fromMajor('12.3.4', 'INR')).toThrow(ValidationError);
      expect(() => money.fromMajor('abc', 'INR')).toThrow(ValidationError);
    });
  });

  describe('assertMinor', () => {
    it('rejects non-integers — the core invariant', () => {
      expect(() => money.assertMinor(10.5)).toThrow(/integer/);
    });
    it('rejects negatives and oversized amounts', () => {
      expect(() => money.assertMinor(-1)).toThrow(/negative/);
      expect(() => money.assertMinor(money.MAX_MINOR_AMOUNT + 1)).toThrow(/maximum/);
    });
  });

  describe('splitByBps', () => {
    it('splits a fee without losing a unit to rounding', () => {
      const { fee, net } = money.splitByBps(100000, 200);
      expect(fee).toBe(2000);
      expect(net).toBe(98000);
      expect(fee + net).toBe(100000);
    });

    it('keeps fee + net exactly equal to the input for awkward amounts', () => {
      // Every one of these rounds; none may leak or invent a minor unit.
      for (const amount of [10001, 3333, 99999, 1, 7, 123457]) {
        const { fee, net } = money.splitByBps(amount, 235);
        expect(fee + net).toBe(amount);
      }
    });

    it('handles a zero-rate merchant', () => {
      expect(money.splitByBps(50000, 0)).toEqual({ fee: 0, net: 50000 });
    });

    it('rejects an out-of-range rate', () => {
      expect(() => money.splitByBps(1000, 10001)).toThrow(ValidationError);
    });
  });

  describe('round trip', () => {
    it('survives major → minor → major for many values', () => {
      for (const value of ['0.01', '9.99', '1000.00', '123456.78']) {
        expect(money.toMajorString(money.fromMajor(value, 'INR'), 'INR')).toBe(value);
      }
    });
  });
});
