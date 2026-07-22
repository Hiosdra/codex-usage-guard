/**
 * Small exact base-10 decimal implementation used by the domain layer.
 * Values are stored as sign * coefficient * 10^-scale.  Division keeps 40
 * decimal places, which is more than enough for quota decisions while never
 * converting credit values to a JavaScript number.
 */
export class Decimal {
  readonly sign: -1 | 0 | 1;
  readonly coefficient: bigint;
  readonly scale: number;

  constructor(value: string | number | bigint, scale = 0) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Invalid decimal number");
      value = String(value);
    }
    if (typeof value === "bigint") {
      this.sign = value === 0n ? 0 : value < 0n ? -1 : 1;
      this.coefficient = value < 0n ? -value : value;
      this.scale = scale;
      return;
    }
    const match = /^\s*([+-])?(\d+)(?:\.(\d+))?\s*$/.exec(value);
    if (!match) throw new Error(`Invalid decimal: ${value}`);
    const sign = match[1] === "-" ? -1 : 1;
    const fraction = match[3] ?? "";
    const coefficient = BigInt(`${match[2]}${fraction}`);
    this.sign = coefficient === 0n ? 0 : sign;
    this.coefficient = coefficient;
    this.scale = fraction.length;
  }

  static zero(): Decimal {
    return new Decimal(0n);
  }
  static one(): Decimal {
    return new Decimal(1n);
  }
  static parse(value: string | number | bigint | Decimal): Decimal {
    return value instanceof Decimal ? value : new Decimal(value);
  }

  private static fromParts(
    sign: -1 | 0 | 1,
    coefficient: bigint,
    scale: number,
  ): Decimal {
    if (coefficient === 0n) return Decimal.zero();
    while (scale > 0 && coefficient % 10n === 0n) {
      coefficient /= 10n;
      scale -= 1;
    }
    const result = Object.create(Decimal.prototype) as Decimal;
    Object.assign(result, { sign, coefficient, scale });
    return result;
  }

  private aligned(other: Decimal): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale);
    const left =
      BigInt(this.sign) * this.coefficient * 10n ** BigInt(scale - this.scale);
    const right =
      BigInt(other.sign) *
      other.coefficient *
      10n ** BigInt(scale - other.scale);
    return [left, right, scale];
  }

  plus(other: Decimal | string | number): Decimal {
    const rhs = Decimal.parse(other);
    const [left, right, scale] = this.aligned(rhs);
    const value = left + right;
    return Decimal.fromParts(
      value < 0n ? -1 : value > 0n ? 1 : 0,
      value < 0n ? -value : value,
      scale,
    );
  }
  minus(other: Decimal | string | number): Decimal {
    return this.plus(Decimal.parse(other).negated());
  }
  times(other: Decimal | string | number): Decimal {
    const rhs = Decimal.parse(other);
    const value = this.coefficient * rhs.coefficient;
    const sign =
      this.sign === 0 || rhs.sign === 0 ? 0 : this.sign === rhs.sign ? 1 : -1;
    return Decimal.fromParts(sign, value, this.scale + rhs.scale);
  }
  div(other: Decimal | string | number, precision = 40): Decimal {
    const rhs = Decimal.parse(other);
    if (rhs.sign === 0) throw new Error("Division by zero");
    if (this.sign === 0) return Decimal.zero();
    const numerator = this.coefficient * 10n ** BigInt(precision + rhs.scale);
    const denominator = rhs.coefficient * 10n ** BigInt(this.scale);
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
    const sign = this.sign === rhs.sign ? 1 : -1;
    return Decimal.fromParts(sign, rounded, precision);
  }
  negated(): Decimal {
    return Decimal.fromParts(
      this.sign === 0 ? 0 : this.sign === 1 ? -1 : 1,
      this.coefficient,
      this.scale,
    );
  }
  abs(): Decimal {
    return this.sign < 0 ? this.negated() : this;
  }
  isZero(): boolean {
    return this.sign === 0;
  }
  isPositive(): boolean {
    return this.sign > 0;
  }
  isNegative(): boolean {
    return this.sign < 0;
  }
  compare(other: Decimal | string | number): -1 | 0 | 1 {
    const rhs = Decimal.parse(other);
    const [left, right] = this.aligned(rhs);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  greaterThan(other: Decimal | string | number): boolean {
    return this.compare(other) > 0;
  }
  greaterThanOrEqual(other: Decimal | string | number): boolean {
    return this.compare(other) >= 0;
  }
  lessThan(other: Decimal | string | number): boolean {
    return this.compare(other) < 0;
  }
  lessThanOrEqual(other: Decimal | string | number): boolean {
    return this.compare(other) <= 0;
  }

  toString(): string {
    if (this.sign === 0) return "0";
    let digits = this.coefficient.toString();
    if (this.scale > 0) {
      if (digits.length <= this.scale)
        digits = digits.padStart(this.scale + 1, "0");
      digits = `${digits.slice(0, -this.scale)}.${digits.slice(-this.scale)}`;
    }
    return this.sign < 0 ? `-${digits}` : digits;
  }
  toFixed(places: number): string {
    if (!Number.isInteger(places) || places < 0)
      throw new Error("Invalid decimal places");
    const scaled = this.div(Decimal.one(), Math.max(places + 2, 42));
    let digits = scaled.coefficient.toString();
    if (scaled.scale < places) digits += "0".repeat(places - scaled.scale);
    if (scaled.scale > places) {
      const cut = scaled.scale - places;
      const kept = BigInt(digits.slice(0, -cut) || "0");
      const discarded = digits.slice(-cut);
      const rounded =
        discarded[0] !== undefined && discarded[0] >= "5" ? kept + 1n : kept;
      digits = rounded.toString();
    }
    if (places > 0) {
      if (digits.length <= places) digits = digits.padStart(places + 1, "0");
      digits = `${digits.slice(0, -places)}.${digits.slice(-places)}`;
    }
    return scaled.sign < 0 ? `-${digits}` : digits;
  }
}
