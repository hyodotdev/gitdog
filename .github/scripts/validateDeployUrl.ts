import { BlockList, isIP } from "node:net";

type Cidr = readonly [address: string, prefix: number];
type IpFamily = "ipv4" | "ipv6";

const NON_GLOBAL_IPV4_CIDRS: readonly Cidr[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const GLOBAL_IPV4_EXCEPTIONS = new Set(["192.0.0.9", "192.0.0.10"]);

const GLOBAL_IPV6_CIDRS: readonly Cidr[] = [
  ["2000::", 3],
  ["64:ff9b::", 96],
];

const NON_GLOBAL_IPV6_CIDRS: readonly Cidr[] = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2d00::", 8],
  ["2e00::", 7],
  ["3000::", 4],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

const GLOBAL_IPV6_EXCEPTIONS: readonly Cidr[] = [
  ["2001:1::1", 128],
  ["2001:1::2", 128],
  ["2001:1::3", 128],
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:20::", 28],
  ["2001:30::", 28],
];

function createBlockList(cidrs: readonly Cidr[], family: IpFamily): BlockList {
  const blockList = new BlockList();
  for (const [address, prefix] of cidrs) {
    blockList.addSubnet(address, prefix, family);
  }
  return blockList;
}

const nonGlobalIpv4Addresses = createBlockList(NON_GLOBAL_IPV4_CIDRS, "ipv4");
const globalIpv6Addresses = createBlockList(GLOBAL_IPV6_CIDRS, "ipv6");
const nonGlobalIpv6Addresses = createBlockList(NON_GLOBAL_IPV6_CIDRS, "ipv6");
const globalIpv6Exceptions = createBlockList(GLOBAL_IPV6_EXCEPTIONS, "ipv6");

function normalizeHostname(hostname: string): string {
  const unwrapped = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return unwrapped.endsWith(".") ? unwrapped.slice(0, -1) : unwrapped;
}

function isGlobalIpv4Address(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;

  return (
    GLOBAL_IPV4_EXCEPTIONS.has(hostname) ||
    !nonGlobalIpv4Addresses.check(hostname, "ipv4")
  );
}

function embeddedIpv4Address(hostname: string): string | undefined {
  // WHATWG URL parsing canonicalizes dotted input to hexadecimal hextets.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
  const compatibleOrNat64 =
    /^(?:::|64:ff9b::)(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})$/.exec(hostname);
  const match = mapped ?? compatibleOrNat64;
  if (!match) return undefined;

  const high = Number.parseInt(match[1] ?? "0", 16);
  const low = Number.parseInt(match[2], 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
}

function isGlobalIpv6Address(hostname: string): boolean {
  if (isIP(hostname) !== 6) return false;

  const embeddedIpv4 = embeddedIpv4Address(hostname);
  if (embeddedIpv4 !== undefined) {
    return isGlobalIpv4Address(embeddedIpv4);
  }

  if (globalIpv6Exceptions.check(hostname, "ipv6")) return true;
  return (
    globalIpv6Addresses.check(hostname, "ipv6") &&
    !nonGlobalIpv6Addresses.check(hostname, "ipv6")
  );
}

/** Validate an exact deploy-time public HTTPS origin without DNS resolution. */
export function isUsableHttpsDeploymentUrl(value: string | undefined): boolean {
  if (!value || value !== value.trim()) return false;

  try {
    const url = new URL(value);
    const hostname = normalizeHostname(url.hostname);
    if (
      url.protocol !== "https:" ||
      value !== url.origin ||
      !hostname ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return false;
    }

    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return false;
    }

    const ipVersion = isIP(hostname);
    return (
      ipVersion === 0 ||
      (ipVersion === 4 && isGlobalIpv4Address(hostname)) ||
      (ipVersion === 6 && isGlobalIpv6Address(hostname))
    );
  } catch {
    return false;
  }
}

if (
  import.meta.main &&
  !isUsableHttpsDeploymentUrl(process.env.DEPLOY_URL_TO_VALIDATE)
) {
  process.exit(1);
}
