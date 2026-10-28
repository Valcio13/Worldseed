import { describe, expect, it } from 'vitest';
import {
  addValues,
  compareValues,
  formatValue,
  multiplyByNumber,
  valueFromDecimalString,
  valueFromNumber,
  valueToNumber,
} from './decimal';

describe('economy large-number values', () => {
  it('adds, multiplies, and formats values beyond JavaScript number range', () => {
    const huge = valueFromDecimalString('4.25e1000');
    const doubled = multiplyByNumber(huge, 2);
    expect(doubled).toEqual({ mantissa: 8.5, exponent: 1000 });
    expect(addValues(huge, huge)).toEqual(doubled);
    expect(formatValue(doubled)).toBe('8.50e1000');
  });

  it('formats common compact suffixes and keeps exact comparisons', () => {
    expect(formatValue(valueFromNumber(1_250_000))).toBe('1.25M');
    expect(compareValues(valueFromDecimalString('1e100'), valueFromDecimalString('9e99'))).toBe(1);
  });

  it('rejects invalid numbers instead of admitting NaN or Infinity', () => {
    expect(() => valueFromNumber(Number.NaN)).toThrow(/finite/);
    expect(() => valueFromNumber(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => valueToNumber(valueFromDecimalString('1e1000'))).toThrow(/represented/);
  });
});
