import { setTimeout as delay } from "node:timers/promises";

export interface RetryPolicy {
  readonly attempts: number;
  readonly delayMs: (attempt: number) => number;
}

export const retry = async <T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  onRetry?: (cause: unknown, attempt: number, attempts: number) => void | Promise<void>,
): Promise<T> => {
  const attempts = Math.max(1, policy.attempts);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (cause) {
      if (attempt >= attempts) throw cause;
      await onRetry?.(cause, attempt, attempts);
      const millis = policy.delayMs(attempt);
      if (millis > 0) await delay(millis);
    }
  }
};
