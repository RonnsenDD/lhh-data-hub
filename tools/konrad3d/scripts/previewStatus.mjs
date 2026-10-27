export const STALE_AFTER_MS = 15 * 60 * 1000;

export function statusFor(validAt, available, relevantCount = 1, now = new Date()) {
  if (!available || !validAt || !Number.isFinite(Date.parse(validAt))) return 'unavailable';
  const age = now.getTime() - Date.parse(validAt);
  if (age < -5 * 60_000 || age > STALE_AFTER_MS) return 'stale';
  void relevantCount;
  return 'current';
}
