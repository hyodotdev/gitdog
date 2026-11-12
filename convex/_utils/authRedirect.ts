/** Keep web redirects same-origin and allow the CLI's exact loopback URL. */
export function resolveAuthRedirect(
  redirectTo: string,
  siteUrl: string,
): string {
  const loopback =
    /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})\/gitdog\/callback\?state=[a-f0-9]{64}$/.exec(
      redirectTo,
    );
  if (
    loopback &&
    loopback[0] === redirectTo &&
    Number(loopback[1]) >= 1024 &&
    Number(loopback[1]) <= 65535
  ) {
    return redirectTo;
  }

  const base = new URL(siteUrl);
  const target = new URL(redirectTo, base);
  if (
    (base.protocol === "https:" || base.protocol === "http:") &&
    target.origin === base.origin &&
    target.username === "" &&
    target.password === ""
  ) {
    return target.toString();
  }
  throw new Error("Invalid authentication redirect destination");
}
