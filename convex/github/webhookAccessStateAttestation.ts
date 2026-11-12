export const INSTALLATION_WEBHOOK_STATE_MAX_RETRY_COUNT = 12;
export const INSTALLATION_WEBHOOK_STATE_MAX_RETRY_DELAY_MS = 60 * 1_000;
export const INSTALLATION_WEBHOOK_STATE_ATTEMPT_LEASE_MS = 15 * 60 * 1_000;

export function getInstallationWebhookStateRetryDelayMs(
  retryCount: number,
): number {
  return Math.min(
    INSTALLATION_WEBHOOK_STATE_MAX_RETRY_DELAY_MS,
    1_000 * 2 ** Math.min(retryCount, 8),
  );
}
