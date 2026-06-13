import { afterEach, describe, expect, it } from "vitest";
import {
  assertHttpUrlAllowed,
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

  it("applies the same policy to final or redirected URLs", async () => {
    await expect(
      assertHttpUrlAllowed("http://127.0.0.1/after-redirect"),
    ).rejects.toThrow(/private\/local/);
  });
});
