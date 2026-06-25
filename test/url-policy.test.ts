import { afterEach, describe, expect, it } from "vitest";
import {
  assertHttpUrlAllowed,
  createPolicyFetch,
  normalizeHttpUrl,
} from "../src/security/url-policy";

describe("normalizeHttpUrl", () => {
  const oldAllow = process.env.READ_PAGE_ALLOW_PRIVATE_NETWORK;

  afterEach(() => {
    if (oldAllow === undefined)
      delete process.env.READ_PAGE_ALLOW_PRIVATE_NETWORK;
    else process.env.READ_PAGE_ALLOW_PRIVATE_NETWORK = oldAllow;
  });

  it("canonicalizes fragment, query, hostname, and trailing slash by default", () => {
    const result = normalizeHttpUrl("https://Example.COM/a/b/?utm=x#section", {
      preserveQuery: false,
    });
    expect(result.url).toBe("https://example.com/a/b");
    expect(result.normalization).toEqual({
      strip_fragment: true,
      strip_query: true,
      strip_trailing_slash: true,
    });
  });

  it("preserves query when requested", () => {
    const result = normalizeHttpUrl("https://example.com/search/?q=agent#top", {
      preserveQuery: true,
    });
    expect(result.url).toBe("https://example.com/search?q=agent");
    expect(result.normalization.strip_query).toBe(false);
  });

  it("rejects non-http schemes", () => {
    expect(() =>
      normalizeHttpUrl("file:///etc/passwd", { preserveQuery: false }),
    ).toThrow(/Only http/);
  });

  it("rejects localhost and private IPs by default", () => {
    expect(() =>
      normalizeHttpUrl("http://localhost:3000", { preserveQuery: false }),
    ).toThrow(/private\/local/);
    expect(() =>
      normalizeHttpUrl("http://127.0.0.1", { preserveQuery: false }),
    ).toThrow(/private\/local/);
    expect(() =>
      normalizeHttpUrl("http://169.254.169.254/latest/meta-data", {
        preserveQuery: false,
      }),
    ).toThrow(/private\/local/);
    expect(() =>
      normalizeHttpUrl("http://192.168.1.1", { preserveQuery: false }),
    ).toThrow(/private\/local/);
  });

  it("allows private network only with explicit opt-in", () => {
    process.env.READ_PAGE_ALLOW_PRIVATE_NETWORK = "1";
    expect(
      normalizeHttpUrl("http://127.0.0.1:3000/a", { preserveQuery: false }).url,
    ).toBe("http://127.0.0.1:3000/a");
  });

  it("rejects IPv4-mapped IPv6 private addresses", () => {
    for (const url of [
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:172.16.0.1]/",
      "http://[::ffff:192.168.0.1]/",
      "http://[::ffff:169.254.0.1]/",
      "http://[::ffff:100.64.0.1]/",
    ]) {
      expect(() => normalizeHttpUrl(url, { preserveQuery: false })).toThrow(
        /private\/local/,
      );
    }
  });

  it("allows public IPv4-mapped IPv6 addresses", () => {
    expect(
      normalizeHttpUrl("http://[::ffff:93.184.216.34]/", {
        preserveQuery: false,
      }).url,
    ).toBe("http://[::ffff:5db8:d822]/");
  });

  it("rejects private pure IPv6 addresses", () => {
    for (const url of [
      "http://[::1]/",
      "http://[::]/",
      "http://[fc00::1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[ff02::1]/",
      "http://[::192.168.1.1]/",
    ]) {
      expect(() => normalizeHttpUrl(url, { preserveQuery: false })).toThrow(
        /private\/local/,
      );
    }
  });

  it("allows public pure IPv6 addresses", () => {
    expect(
      normalizeHttpUrl("http://[2606:2800:220:1:248:1893:25c8:1946]/", {
        preserveQuery: false,
      }).url,
    ).toBe("http://[2606:2800:220:1:248:1893:25c8:1946]/");
  });

  it("applies the same policy to final or redirected URLs", async () => {
    await expect(
      assertHttpUrlAllowed("http://127.0.0.1/after-redirect"),
    ).rejects.toThrow(/private\/local/);
  });

  it("applies URL policy before delegated fetch calls", async () => {
    const calls: string[] = [];
    const policyFetch = createPolicyFetch(async (input) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response("ok");
    });

    await expect(policyFetch("http://127.0.0.1/secret")).rejects.toThrow(
      /private\/local/,
    );
    expect(calls).toEqual([]);

    const response = await policyFetch("https://93.184.216.34/");
    expect(await response.text()).toBe("ok");
    expect(calls).toEqual(["https://93.184.216.34/"]);
  });

  it("applies URL policy before following delegated fetch redirects", async () => {
    const calls: string[] = [];
    const policyFetch = createPolicyFetch(async (input) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      });
    });

    await expect(policyFetch("https://93.184.216.34/start")).rejects.toThrow(
      /private\/local/,
    );
    expect(calls).toEqual(["https://93.184.216.34/start"]);
  });
});
