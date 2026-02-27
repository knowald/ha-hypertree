/** Complex number as [real, imaginary] tuple. */
export type Complex = [number, number];

export const ORIGIN: Complex = [0, 0];

export function add(a: Complex, b: Complex): Complex {
  return [a[0] + b[0], a[1] + b[1]];
}

export function sub(a: Complex, b: Complex): Complex {
  return [a[0] - b[0], a[1] - b[1]];
}

export function mul(a: Complex, b: Complex): Complex {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}

export function div(a: Complex, b: Complex): Complex {
  const denom = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / denom, (a[1] * b[0] - a[0] * b[1]) / denom];
}

export function conj(z: Complex): Complex {
  return [z[0], -z[1]];
}

export function abs(z: Complex): number {
  return Math.sqrt(z[0] * z[0] + z[1] * z[1]);
}

export function scale(z: Complex, s: number): Complex {
  return [z[0] * s, z[1] * s];
}

export function fromPolar(r: number, theta: number): Complex {
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

export function arg(z: Complex): number {
  return Math.atan2(z[1], z[0]);
}
