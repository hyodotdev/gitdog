/**
 * Local ports the CLI listens on for its sign-in callback, tried in order.
 * @convex-dev/auth 2.0 returns only to exact origins, so the CLI cannot pick
 * a random port. packages/cli/src/auth.ts lists the same ports.
 */
export const CLI_LOGIN_PORTS = [41721, 41722, 41723, 41724, 41725] as const;

/** Where a sign-in may return: Gitdog's site or the CLI's loopback listener. */
export function allowedSignInOrigins(siteUrl: string): string[] {
  return [
    new URL(siteUrl).origin,
    ...CLI_LOGIN_PORTS.map((port) => `http://127.0.0.1:${port}`),
  ];
}
