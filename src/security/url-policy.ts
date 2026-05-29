import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type UrlNormalization = {
  strip_fragment: boolean;
  strip_query: boolean;
  strip_trailing_slash: boolean;
};

export type NormalizedUrl = {
  inputUrl: string;
  url: string;
  normalization: UrlNormalization;
};

const dnsPolicyCache = new Map<string, Promise<void>>();

export function normalizeHttpUrl(
  input: string,
  options: { preserveQuery: boolean },
): NormalizedUrl {
  const parsed = parseHttpUrl(input);
  const inputUrl = input.trim();

  parsed.hostname = parsed.hostname.toLowerCase();
  enforceHostPolicy(parsed.hostname);
  parsed.hash = "";

  const stripQuery = !options.preserveQuery;
  if (stripQuery) parsed.search = "";

  const stripTrailingSlash =
    parsed.pathname !== "/" && parsed.pathname.endsWith("/");
  if (stripTrailingSlash)
    parsed.pathname = parsed.pathname.replace(/\/+$/g, "");

  return {
    inputUrl,
    url: parsed.toString(),
    normalization: {
      strip_fragment: true,
      strip_query: stripQuery,
      strip_trailing_slash: stripTrailingSlash,
    },
  };
}

export async function assertHttpUrlAllowed(url: string): Promise<void> {
  const parsed = parseHttpUrl(url);
  enforceHostPolicy(parsed.hostname);

  if (allowsPrivateNetwork()) return;
  const host = normalizeHost(parsed.hostname);
  if (isIP(host)) return;

  let cached = dnsPolicyCache.get(host);
  if (!cached) {
    cached = enforceDnsPolicy(host);
    dnsPolicyCache.set(host, cached);
  }
  await cached;
}

export function isHttpLikeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function parseHttpUrl(input: string): URL {
  let parsed: URL;

  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Only http:// and https:// URLs are supported. Refusing URL: ${input}`,
    );
  }

  return parsed;
}

async function enforceDnsPolicy(host: string): Promise<void> {
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(
      `Failed to resolve hostname ${host}: ${errorMessage(error)}`,
    );
  }

  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error(
        `Refusing hostname ${host} because DNS resolved to private/local address ${record.address}. Set WEB_READ_ALLOW_PRIVATE_NETWORK=1 to allow it explicitly.`,
      );
    }
  }
}

function enforceHostPolicy(hostname: string): void {
  if (allowsPrivateNetwork()) return;

  const host = normalizeHost(hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error(
      `Refusing private/local hostname: ${hostname}. Set WEB_READ_ALLOW_PRIVATE_NETWORK=1 to allow it explicitly.`,
    );
  }

  if (isIP(host) && isPrivateIp(host)) {
    throw new Error(
      `Refusing private/local IP address: ${hostname}. Set WEB_READ_ALLOW_PRIVATE_NETWORK=1 to allow it explicitly.`,
    );
  }
}

function isPrivateIp(ip: string): boolean {
  const ipVersion = isIP(ip);
  if (ipVersion === 4) return isPrivateIPv4(ip);
  if (ipVersion === 6) return isPrivateIPv6(ip);
  return true;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:169.254.")
  );
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function allowsPrivateNetwork(): boolean {
  return process.env.WEB_READ_ALLOW_PRIVATE_NETWORK === "1";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
