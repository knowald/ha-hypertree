import { type Complex, ORIGIN, add, sub, mul, div, conj, abs, scale } from "./complex";

/**
 * Mobius translation: maps z0 to origin while preserving the Poincare disk.
 * T(z) = (z - z0) / (1 - conj(z0) * z)
 */
export function mobiusTranslate(z: Complex, z0: Complex): Complex {
  const num = sub(z, z0);
  const denom = sub([1, 0], mul(conj(z0), z));
  return div(num, denom);
}

/**
 * Inverse Mobius translation: maps origin back to z0.
 * T^-1(z) = (z + z0) / (1 + conj(z0) * z)
 */
export function mobiusTranslateInv(z: Complex, z0: Complex): Complex {
  const num = add(z, z0);
  const denom = add([1, 0], mul(conj(z0), z));
  return div(num, denom);
}

/**
 * Interpolate along the geodesic from a to b in the Poincare disk.
 * Uses Mobius translation to map a to origin, lerp toward b, then map back.
 */
export function geodesicInterpolate(a: Complex, b: Complex, t: number): Complex {
  if (t <= 0) return a;
  if (t >= 1) return b;

  const bMapped = mobiusTranslate(b, a);
  const interp: Complex = scale(bMapped, t);
  return mobiusTranslateInv(interp, a);
}

/**
 * Compute the SVG arc parameters for a geodesic between two points
 * on the Poincare disk. Returns a path string "M ... A ..." or "M ... L ..."
 * for near-diameters.
 */
export function geodesicArcPath(a: Complex, b: Complex): string {
  const ax = a[0],
    ay = a[1];
  const bx = b[0],
    by = b[1];

  const cross = ax * by - ay * bx;
  if (Math.abs(cross) < 1e-6) {
    return `M ${ax} ${ay} L ${bx} ${by}`;
  }

  const aAbsSq = ax * ax + ay * ay;
  if (aAbsSq < 1e-10) {
    return `M ${ax} ${ay} L ${bx} ${by}`;
  }

  const invAx = ax / aAbsSq;
  const invAy = ay / aAbsSq;

  const cx = circumcircleCenter(ax, ay, bx, by, invAx, invAy);
  if (!cx) {
    return `M ${ax} ${ay} L ${bx} ${by}`;
  }

  const [ccx, ccy] = cx;
  const radius = Math.sqrt((ax - ccx) ** 2 + (ay - ccy) ** 2);

  // Determine sweep direction
  const startAngle = Math.atan2(ay - ccy, ax - ccx);
  const endAngle = Math.atan2(by - ccy, bx - ccx);
  let sweep = endAngle - startAngle;
  if (sweep > Math.PI) sweep -= 2 * Math.PI;
  if (sweep < -Math.PI) sweep += 2 * Math.PI;
  const sweepFlag = sweep > 0 ? 1 : 0;

  return `M ${ax} ${ay} A ${radius} ${radius} 0 0 ${sweepFlag} ${bx} ${by}`;
}

function circumcircleCenter(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number
): [number, number] | null {
  const D = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(D) < 1e-10) return null;

  const ux =
    ((x1 * x1 + y1 * y1) * (y2 - y3) +
      (x2 * x2 + y2 * y2) * (y3 - y1) +
      (x3 * x3 + y3 * y3) * (y1 - y2)) /
    D;
  const uy =
    ((x1 * x1 + y1 * y1) * (x3 - x2) +
      (x2 * x2 + y2 * y2) * (x1 - x3) +
      (x3 * x3 + y3 * y3) * (x2 - x1)) /
    D;

  return [ux, uy];
}

export function applyFocus(
  nodes: { z: Complex; screenZ: Complex }[],
  focus: Complex
): void {
  if (abs(focus) < 1e-10) {
    for (const node of nodes) {
      node.screenZ = node.z;
    }
    return;
  }
  for (const node of nodes) {
    node.screenZ = mobiusTranslate(node.z, focus);
  }
}

export function clampToDisk(z: Complex, maxRadius = 0.95): Complex {
  const r = abs(z);
  if (r > maxRadius) {
    return scale(z, maxRadius / r);
  }
  return z;
}

export { ORIGIN };
