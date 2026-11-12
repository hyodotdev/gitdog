export const REPOSITORY_ACCESS_RECONCILIATION_MAX_RETRY_COUNT = 12;
export const REPOSITORY_ACCESS_RECONCILIATION_MAX_RETRY_DELAY_MS =
  5 * 60 * 1_000;
export const REPOSITORY_ACCESS_RECONCILIATION_ATTEMPT_LEASE_MS =
  10 * 60 * 1_000;

export function getRepositoryAccessReconciliationRetryDelayMs(
  retryCount: number,
): number {
  return Math.min(
    REPOSITORY_ACCESS_RECONCILIATION_MAX_RETRY_DELAY_MS,
    1_000 * 2 ** Math.min(retryCount, 8),
  );
}
