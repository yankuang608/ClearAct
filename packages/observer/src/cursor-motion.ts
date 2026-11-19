// SPDX-License-Identifier: MIT
export interface CursorPoint {x: number; y: number}

/** Readable, bounded travel even between nearby fields. */
export function cursorDuration(from: CursorPoint, to: CursorPoint): number {
  return Math.min(650, 400 + Math.hypot(to.x - from.x, to.y - from.y) * .2);
}

/** Smoothstep timing on a shallow quadratic curve, with an exact final coordinate. */
export function cursorPoint(from: CursorPoint, to: CursorPoint, progress: number): CursorPoint {
  if (progress <= 0) return {...from};
  if (progress >= 1) return {...to};
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (!distance) return {...to};
  const t = progress * progress * (3 - 2 * progress);
  const bend = Math.min(36, distance * .06);
  const offset = 2 * (1 - t) * t * bend;
  return {
    x: from.x + (to.x - from.x) * t + (to.y - from.y) / distance * offset,
    y: from.y + (to.y - from.y) * t - (to.x - from.x) / distance * offset,
  };
}
