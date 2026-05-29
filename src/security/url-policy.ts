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

export function normalizeHttpUrl(input: string, options: { preserveQuery: boolean }): NormalizedUrl {
  const inputUrl = input.trim();
  let parsed: URL;

  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http:// and https:// URLs are supported. Refusing URL: ${input}`);
  }

  parsed.hostname = parsed.hostname.toLowerCase();
  enforceHostPolicy(parsed.hostname);
  parsed.hash = "";

  const stripQuery = !options.preserveQuery;
  if (stripQuery) parsed.search = "";

  const stripTrailingSlash = parsed.pathname !== "/" && parsed.pathname.endsWith("/");
  if (stripTrailingSlash) parsed.pathname = parsed.pathname.replace(/\/+$/g, "");

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

function enforceHostPolicy(hostname: string): void {
  if (process.env.WEB_READ_ALLOW_PRIVATE_NETWORK === "1") return;

  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Refusing private/local hostname: ${hostname}. Set WEB_READ_ALLOW_PRIVATE_NETWORK=1 to allow it explicitly.`);
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4 && isPrivateIPv4(host)) {
    throw new Error(`Refusing private/local IPv4 address: ${hostname}. Set WEB_READ_ALLOW_PRIVATE_NETWORK=1 to allow it explicitly.`);
  }
  if (ipVersion === 6 && isPrivateIPv6(host)) {
    throw new Error(`Refusing private/local IPv6 address: ${hostname}. Set WEB_READ_ALLOW_PRIVATE_NETWORK=1 to allow it explicitly.`);
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
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
