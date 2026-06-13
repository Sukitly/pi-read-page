import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CacheMeta,
  loadCachedFromPaths,
  sha256,
} from "../src/cache/cache";

function metaFor(url: string, markdown: string): CacheMeta {
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
    content_sha256: sha256(markdown),
    chars: markdown.length,
    lines: markdown.split(/\r?\n/).length,
  };
}

describe("cache integrity", () => {
  it("loads valid cached content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "read-page-cache-test-"));
    const mdPath = path.join(dir, "content.md");
    const metaPath = path.join(dir, "meta.json");
    const url = "https://example.com";
    const markdown = "hello";
    await writeFile(mdPath, markdown, "utf8");
    await writeFile(metaPath, JSON.stringify(metaFor(url, markdown)), "utf8");

    const cached = await loadCachedFromPaths(url, { mdPath, metaPath });
    expect(cached.markdown).toBe(markdown);
    expect(cached.fresh).toBe(true);
  });

  it("rejects checksum mismatch instead of treating it as a normal miss", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "read-page-cache-test-"));
    const mdPath = path.join(dir, "content.md");
    const metaPath = path.join(dir, "meta.json");
    const url = "https://example.com";
    await writeFile(mdPath, "changed", "utf8");
    await writeFile(metaPath, JSON.stringify(metaFor(url, "original")), "utf8");

    await expect(
      loadCachedFromPaths(url, { mdPath, metaPath }),
    ).rejects.toThrow(/checksum mismatch/);
  });
});
