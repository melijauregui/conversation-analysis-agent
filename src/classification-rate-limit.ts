type RateLimitError = Error & {
  status?: number;
  code?: string | null;
  headers?: Headers;
};

export function retryAfterMs(error: RateLimitError, now = Date.now()): number {
  const millis = error.headers?.get("retry-after-ms");
  if (millis && Number.isFinite(Number(millis)) && Number(millis) >= 0) {
    return Number(millis);
  }
  const retryAfter = error.headers?.get("retry-after");
  if (retryAfter) {
    const duration = Number.isFinite(Number(retryAfter))
      ? Number(retryAfter) * 1000
      : Date.parse(retryAfter) - now;
    if (Number.isFinite(duration)) return Math.max(0, duration);
  }
  const match = error.message.match(/try again in ([\d.]+)(ms|s)/i);
  return match ? Number(match[1]) * (match[2]!.toLowerCase() === "s" ? 1000 : 1) : 0;
}

