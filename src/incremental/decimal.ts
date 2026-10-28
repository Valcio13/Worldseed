/** Non-negative base-10 floating representation for the local incremental economy. */
export interface BigValue {
  mantissa: number;
  exponent: number;
}

export const ZERO: BigValue = Object.freeze({ mantissa: 0, exponent: 0 });
export const ONE: BigValue = Object.freeze({ mantissa: 1, exponent: 0 });
const MAX_EXPONENT = Number.MAX_SAFE_INTEGER;

function normalized(mantissa: number, exponent: number): BigValue {
  if (!Number.isFinite(mantissa) || !Number.isFinite(exponent) || mantissa < 0)
    throw new RangeError('BigValue must be finite and non-negative.');
  if (mantissa === 0) return ZERO;
  const shift = Math.floor(Math.log10(mantissa));
  const nextExponent = exponent + shift;
  if (!Number.isSafeInteger(nextExponent) || Math.abs(nextExponent) > MAX_EXPONENT)
    throw new RangeError('BigValue exponent is outside the supported range.');
  let nextMantissa = mantissa / 10 ** shift;
  if (nextMantissa >= 10) {
    nextMantissa /= 10;
    return { mantissa: nextMantissa, exponent: nextExponent + 1 };
  }
  if (nextMantissa < 1) {
    nextMantissa *= 10;
    return { mantissa: nextMantissa, exponent: nextExponent - 1 };
  }
  return { mantissa: nextMantissa, exponent: nextExponent };
}

export function valueFromNumber(value: number): BigValue {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError('Economy values must be finite and non-negative.');
  if (value === 0) return ZERO;
  return normalized(value, 0);
}

export function valueFromParts(mantissa: number, exponent: number): BigValue {
  return normalized(mantissa, exponent);
}

export function valueFromDecimalString(value: string): BigValue {
  const match = /^\s*(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?\s*$/i.exec(value);
  if (!match) throw new RangeError('Invalid non-negative decimal string.');
  const significand = Number(match[1]);
  const exponent = Number(match[2] ?? 0);
  if (!Number.isFinite(significand) || !Number.isSafeInteger(exponent))
    throw new RangeError('Decimal string is outside the supported range.');
  return normalized(significand, exponent);
}

export function addValues(left: BigValue, right: BigValue): BigValue {
  if (left.mantissa === 0) return right;
  if (right.mantissa === 0) return left;
  const larger = left.exponent >= right.exponent ? left : right;
  const smaller = larger === left ? right : left;
  const difference = larger.exponent - smaller.exponent;
  if (difference > 16) return larger;
  return normalized(larger.mantissa + smaller.mantissa / 10 ** difference, larger.exponent);
}

export function subtractValues(left: BigValue, right: BigValue): BigValue {
  if (compareValues(left, right) <= 0) return ZERO;
  const difference = left.exponent - right.exponent;
  if (difference > 16) return left;
  return normalized(left.mantissa - right.mantissa / 10 ** difference, left.exponent);
}

export function multiplyValues(left: BigValue, right: BigValue): BigValue {
  if (left.mantissa === 0 || right.mantissa === 0) return ZERO;
  return normalized(left.mantissa * right.mantissa, left.exponent + right.exponent);
}

export function multiplyByNumber(value: BigValue, factor: number): BigValue {
  if (!Number.isFinite(factor) || factor < 0)
    throw new RangeError('Multipliers must be finite and non-negative.');
  if (factor === 0 || value.mantissa === 0) return ZERO;
  return normalized(value.mantissa * factor, value.exponent);
}

export function divideByNumber(value: BigValue, divisor: number): BigValue {
  if (!Number.isFinite(divisor) || divisor <= 0)
    throw new RangeError('Divisors must be finite and greater than zero.');
  if (value.mantissa === 0) return ZERO;
  return normalized(value.mantissa / divisor, value.exponent);
}

export function compareValues(left: BigValue, right: BigValue): number {
  if (left.mantissa === 0) return right.mantissa === 0 ? 0 : -1;
  if (right.mantissa === 0) return 1;
  if (left.exponent !== right.exponent) return left.exponent < right.exponent ? -1 : 1;
  return left.mantissa === right.mantissa ? 0 : left.mantissa < right.mantissa ? -1 : 1;
}

export function pow10(exponent: number): BigValue {
  if (!Number.isFinite(exponent)) throw new RangeError('Exponent must be finite.');
  const whole = Math.floor(exponent);
  return normalized(10 ** (exponent - whole), whole);
}

export function valueToNumber(value: BigValue): number {
  if (value.mantissa === 0) return 0;
  if (value.exponent > 308)
    throw new RangeError('This BigValue cannot be represented as a JavaScript number.');
  if (value.exponent < -324) return 0;
  const result = value.mantissa * 10 ** value.exponent;
  if (!Number.isFinite(result))
    throw new RangeError('This BigValue cannot be represented as a JavaScript number.');
  return result;
}

export function formatValue(value: BigValue, significantDigits = 3): string {
  if (value.mantissa === 0) return '0';
  if (!Number.isInteger(significantDigits) || significantDigits < 1 || significantDigits > 6)
    throw new RangeError('Significant digits must be between 1 and 6.');
  const suffixes = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi'];
  if (value.exponent < 3) {
    const number = valueToNumber(value);
    return number.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  const group = Math.floor(value.exponent / 3);
  if (group < suffixes.length) {
    const scaled = value.mantissa * 10 ** (value.exponent - group * 3);
    const digits = Math.max(0, significantDigits - Math.floor(Math.log10(scaled)) - 1);
    return `${Number(scaled.toPrecision(significantDigits)).toLocaleString('en-US', { maximumFractionDigits: digits })}${suffixes[group]}`;
  }
  return `${value.mantissa.toPrecision(significantDigits)}e${value.exponent}`;
}

export function isValidValue(value: unknown): value is BigValue {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BigValue>;
  return (
    typeof candidate.mantissa === 'number' &&
    Number.isFinite(candidate.mantissa) &&
    candidate.mantissa >= 0 &&
    (candidate.mantissa === 0 || (candidate.mantissa >= 1 && candidate.mantissa < 10)) &&
    typeof candidate.exponent === 'number' &&
    Number.isSafeInteger(candidate.exponent)
  );
}
