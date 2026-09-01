'use strict';

const { CURRENCY_EXPONENT } = require('../constants');
const { ValidationError } = require('../errors');

/**
 * Money handling.
 *
 * Every amount in this system is an **integer in the currency's minor unit**
 * (paise, cents). Floating point is never used for money: `0.1 + 0.2 !== 0.3`
 * and a ledger that drifts by a cent is a ledger that fails reconciliation.
 * Conversion to a decimal string happens only at the presentation boundary.
 */

/** Largest amount we accept — comfortably inside `Number.MAX_SAFE_INTEGER`. */
const MAX_MINOR_AMOUNT = 1_000_000_000_000; // 10 billion major units

function exponentFor(currency) {
  const exponent = CURRENCY_EXPONENT[currency];
  if (exponent === undefined) throw new ValidationError(`Unsupported currency: ${currency}`);
  return exponent;
}

/**
 * Validate an amount expressed in minor units.
 * @param {number} minor
 * @returns {number} the same value, once proven safe
 */
function assertMinor(minor) {
  if (!Number.isInteger(minor)) {
    throw new ValidationError('Amount must be an integer in the currency minor unit');
  }
  if (minor < 0) throw new ValidationError('Amount must not be negative');
  if (minor > MAX_MINOR_AMOUNT) throw new ValidationError('Amount exceeds the permitted maximum');
  return minor;
}

/** Convert minor units to a fixed-precision display string, e.g. 125050 → "1250.50". */
function toMajorString(minor, currency) {
  assertMinor(Math.abs(minor));
  const exponent = exponentFor(currency);
  const sign = minor < 0 ? '-' : '';
  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return exponent === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

/**
 * Parse a major-unit string/number into minor units without ever touching
 * floating point arithmetic on the fractional part.
 */
function fromMajor(major, currency) {
  const exponent = exponentFor(currency);
  const text = String(major).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new ValidationError(`Malformed amount: ${major}`);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  if (fraction.length > exponent) {
    throw new ValidationError(`${currency} supports at most ${exponent} decimal places`);
  }
  const minor = Number(whole + fraction.padEnd(exponent, '0'));
  return negative ? -minor : minor;
}

/**
 * Split an amount by a basis-point rate, e.g. a 200 bps (2%) platform fee.
 * Rounds half-up and returns both halves so `fee + net === amount` exactly —
 * the remainder is never lost to rounding.
 * @returns {{ fee: number, net: number }}
 */
function splitByBps(minor, bps) {
  assertMinor(minor);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new ValidationError('Basis points must be an integer between 0 and 10000');
  }
  const fee = Math.round((minor * bps) / 10000);
  return { fee, net: minor - fee };
}

/** Sum minor amounts, validating the total stays in range. */
function sum(amounts) {
  return assertMinor(amounts.reduce((total, amount) => total + amount, 0));
}

module.exports = {
  MAX_MINOR_AMOUNT,
  assertMinor,
  toMajorString,
  fromMajor,
  splitByBps,
  sum,
  exponentFor,
};
