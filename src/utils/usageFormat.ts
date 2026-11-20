export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toString();
}

/** US dollars from cents; amounts that round to zero still show they cost something. */
export function formatUsdCents(cents: number): string {
  if (cents > 0 && cents < 1) return "<$0.01";
  return `$${(cents / 100).toFixed(2)}`;
}

/** USD per 1M tokens without trailing zeros, such as $0.1 or $20. */
export function formatPerMillion(usd: number): string {
  return `$${Number(usd.toFixed(2))}`;
}
