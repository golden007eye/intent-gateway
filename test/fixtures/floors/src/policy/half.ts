export function half(n: number): number {
  if (n > 0) {
    return 1;
  }
  const a = n - 1;
  const b = a * 2;
  const c = b + 3;
  const d = c * 4;
  return d;
}
