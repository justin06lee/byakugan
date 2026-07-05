/**
 * Token estimators. Text uses the standard ~4 chars/token heuristic — good
 * enough for relative comparisons, which is all M0 needs. Image cost follows
 * the Claude rule: tokens ≈ (w × h) / 750 after downscaling so the long edge
 * is ≤ 1568px.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateImageTokens(width: number, height: number): number {
  const long = Math.max(width, height);
  const scale = long > 1568 ? 1568 / long : 1;
  return Math.ceil((width * scale * height * scale) / 750);
}
