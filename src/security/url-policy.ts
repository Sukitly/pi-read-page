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

const dnsPolicyChecks = new Map<string, Promise<void>>();
const MAX_FETCH_REDIRECTS = 20;

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

  const currentCheck = dnsPolicyChecks.get(host);
  if (currentCheck) {
    await currentCheck;
    return;
  }

  let check!: Promise<void>;
  check = enforceDnsPolicy(host).finally(() => {
    if (dnsPolicyChecks.get(host) === check) dnsPolicyChecks.delete(host);
  });
  dnsPolicyChecks.set(host, check);
  await check;
}

export function isHttpLikeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function createPolicyFetch(
  delegate: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const redirectMode = fetchRedirectMode(input, init);
    if (redirectMode !== "follow") {
      await assertHttpUrlAllowed(fetchInputUrl(input));
      return delegate(input, init);
    }

    let nextInput: RequestInfo | URL = input;
    let nextInit: RequestInit = { ...init, redirect: "manual" };

    for (let redirects = 0; redirects <= MAX_FETCH_REDIRECTS; redirects += 1) {
      const currentUrl = fetchInputUrl(nextInput);
      await assertHttpUrlAllowed(currentUrl);
      const response = await delegate(nextInput, nextInit);
      if (!isRedirectResponse(response)) return response;

      const location = response.headers.get("location");
      if (!location) return response;
      if (redirects === MAX_FETCH_REDIRECTS) {
        throw new Error("Fetch redirect limit exceeded");
      }

      const currentInput = nextInput;
      nextInput = new URL(location, currentUrl).href;
      nextInit = nextRedirectInit(currentInput, nextInit, response.status);
    }

    throw new Error("Fetch redirect limit exceeded");
  };
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof input === "object" && input !== null && "url" in input) {
    const url = input.url;
    if (typeof url === "string") return url;
  }
  throw new Error("Unable to determine fetch request URL");
}

function fetchRedirectMode(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): RequestRedirect {
  if (init?.redirect) return init.redirect;
  if (typeof input === "object" && input !== null && "redirect" in input) {
    const redirect = input.redirect;
    if (
      redirect === "error" ||
      redirect === "follow" ||
      redirect === "manual"
    ) {
      return redirect;
    }
  }
  return "follow";
}

function fetchMethod(input: RequestInfo | URL, init: RequestInit): string {
  if (init.method) return init.method.toUpperCase();
  if (typeof input === "object" && input !== null && "method" in input) {
    const method = input.method;
    if (typeof method === "string") return method.toUpperCase();
  }
  return "GET";
}

function nextRedirectInit(
  input: RequestInfo | URL,
  init: RequestInit,
  status: number,
): RequestInit {
  const method = fetchMethod(input, init);
  if (
    status !== 303 &&
    !((status === 301 || status === 302) && method === "POST")
  ) {
    return init;
  }
  return { ...init, method: "GET", body: undefined };
}

function isRedirectResponse(response: Response): boolean {
  return [301, 302, 303, 307, 308].includes(response.status);
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
        `Refusing hostname ${host} because DNS resolved to private/local address ${record.address}. Set READ_PAGE_ALLOW_PRIVATE_NETWORK=1 to allow it explicitly.`,
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
      `Refusing private/local hostname: ${hostname}. Set READ_PAGE_ALLOW_PRIVATE_NETWORK=1 to allow it explicitly.`,
    );
  }

  if (isIP(host) && isPrivateIp(host)) {
    throw new Error(
      `Refusing private/local IP address: ${hostname}. Set READ_PAGE_ALLOW_PRIVATE_NETWORK=1 to allow it explicitly.`,
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
  const normalized = normalizeHost(ip).split("%")[0] || "";
  const mappedIpv4 = ipv4FromMappedIPv6(normalized);
  if (mappedIpv4) return isPrivateIPv4(mappedIpv4);

  const words = parseIPv6Words(normalized);
  if (!words) return true;
  const first = words[0] ?? 0;
  return (
    normalized === "::1" ||
    normalized === "::" ||
    first === 0 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xff00) === 0xff00
  );
}

function ipv4FromMappedIPv6(ip: string): string | undefined {
  const words = parseIPv6Words(ip);
  if (!words) return undefined;
  if (words.slice(0, 5).some((word) => word !== 0) || words[5] !== 0xffff) {
    return undefined;
  }

  const high = words[6] ?? 0;
  const low = words[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function parseIPv6Words(ip: string): number[] | undefined {
  let input = ip.toLowerCase();
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon === -1) return undefined;
    const ipv4 = input.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return undefined;
    const octets = ipv4.split(".").map((part) => Number.parseInt(part, 10));
    const [a, b, c, d] = octets;
    if (
      a === undefined ||
      b === undefined ||
      c === undefined ||
      d === undefined
    ) {
      return undefined;
    }
    input = `${input.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const compressionParts = input.split("::");
  if (compressionParts.length > 2) return undefined;

  const left = parseIPv6Side(compressionParts[0] ?? "");
  const right = parseIPv6Side(compressionParts[1] ?? "");
  if (!left || !right) return undefined;

  if (compressionParts.length === 1) {
    return left.length === 8 ? left : undefined;
  }

  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIPv6Side(input: string): number[] | undefined {
  if (!input) return [];
  const words = input.split(":").map((part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return Number.NaN;
    return Number.parseInt(part, 16);
  });
  return words.every(Number.isFinite) ? words : undefined;
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function allowsPrivateNetwork(): boolean {
  return process.env.READ_PAGE_ALLOW_PRIVATE_NETWORK === "1";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
