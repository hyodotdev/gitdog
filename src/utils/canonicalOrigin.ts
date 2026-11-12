/** Start OAuth on the same origin that receives its callback. */
export function getCanonicalOriginRedirect(href: string): string | null {
  const url = new URL(href);
  if (url.hostname !== "gitdog.hyo.dev") return null;
  url.protocol = "https:";
  url.hostname = "gitdog.dev";
  url.port = "";
  return url.href;
}
