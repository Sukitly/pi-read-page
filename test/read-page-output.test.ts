import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type CacheMeta, paginate, sha256 } from "../src/cache/cache";
import { formatDocument, makeDetails } from "../src/tools/read-page";

function metaFor(url: string): CacheMeta {
  return {
    version: 1,
    input_url: url,
    url,
    final_url: url,
    cache_key: "test",
    url_sha256: sha256(url),
    normalization: {
      strip_fragment: true,
      strip_query: true,
      strip_trailing_slash: false,
    },
    source: "browser",
    extractor: "defuddle",
    extraction: "auto",
    parse_mode: "sync",
    browser_profile: "persistent",
    user_action: false,
    confidence: { level: "high", score: 100, reasons: [] },
    metadata: {
      title: "Example",
      author: "",
      description: "",
      domain: "example.com",
      favicon: "",
      image: "",
      published: "",
      site: "Example",
      language: "en",
      wordCount: 1,
      parseTime: 0,
      metaTags: [],
      variables: {},
    },
    fetched_at: new Date(0).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ttl_days: 30,
    content_sha256: sha256("cached markdown"),
    chars: "cached markdown".length,
    lines: 1,
  };
}

describe("read-page output formatting", () => {
  it("surfaces a byte-truncated page from pagination in output and details", () => {
    const url = "https://example.com/article";
    const oversizedLine = `${"x".repeat(DEFAULT_MAX_BYTES + 1024)}TAIL`;
    const markdown = `${oversizedLine}\nkept-second-line`;
    const pagination = paginate(markdown, 1, 10);
    expect(pagination.truncated).toBe(true);
    const meta = metaFor(url);
    const normalized = {
      inputUrl: url,
      url,
      normalization: meta.normalization,
    };

    const output = formatDocument({
      normalized,
      markdown,
      pagination,
      meta,
      cacheStatus: "miss",
    });
    const details = makeDetails({
      normalized,
      meta,
      cacheStatus: "miss",
      offset: 1,
      limit: 1,
      pagination,
    });

    expect(output).toContain("Warning: selected document page was truncated");
    expect(output).not.toContain("TAIL");
    expect(details.contentTruncated).toBe(true);
    expect(details.contentShownBytes).toBeLessThan(details.contentTotalBytes);
    expect(details.contentShownBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });
});
