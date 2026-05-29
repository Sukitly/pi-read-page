import { describe, expect, it } from "vitest";
import { assessConfidence, decideUserAction } from "../src/browser/confidence";
import type { ExtractedPage } from "../src/types";

function page(overrides: Partial<ExtractedPage>): ExtractedPage {
  return {
    url: "https://example.com/article",
    title: "Example",
    markdown:
      "This is a normal short article. It has Log in in the nav but content is readable.",
    contentHtml:
      "<article><p>This is a normal short article.</p><a>Log in</a></article>",
    fullHtml: "",
    textLength: 80,
    capturedAt: new Date(0).toISOString(),
    extractor: "defuddle",
    extraction: "auto",
    parseMode: "sync",
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
      wordCount: 16,
      parseTime: 0,
      metaTags: [],
      variables: {},
    },
    confidence: { level: "high", score: 100, reasons: [] },
    warnings: [],
    ...overrides,
  };
}

function withConfidence(input: Partial<ExtractedPage>): ExtractedPage {
  const base = page(input);
  return { ...base, confidence: assessConfidence(base) };
}

describe("confidence and handoff", () => {
  it("does not hand off just because readable short content contains a login nav link", () => {
    const extracted = withConfidence({});
    const decision = decideUserAction(extracted);
    expect(decision.required).toBe(false);
  });

  it("marks thin content as low confidence without making it user-actionable", () => {
    const extracted = withConfidence({
      markdown: "tiny",
      contentHtml: "<p>tiny</p>",
      metadata: { ...page({}).metadata, wordCount: 1 },
    });
    expect(extracted.confidence.level).toBe("low");
    expect(extracted.confidence.reasons).toContain("markdown_too_short");
    expect(decideUserAction(extracted).required).toBe(false);
  });

  it("hands off captcha pages", () => {
    const extracted = withConfidence({
      markdown: "Please verify you are human",
      contentHtml: "<p>Please verify you are human</p>",
    });
    const decision = decideUserAction(extracted);
    expect(decision.required).toBe(true);
    expect(decision.reason).toBe("captcha");
  });

  it("hands off explicit login walls", () => {
    const extracted = withConfidence({
      url: "https://example.com/login",
      markdown: "Please log in to continue",
      contentHtml: '<form><input type="password"></form>',
      metadata: { ...page({}).metadata, wordCount: 5 },
    });
    const decision = decideUserAction(extracted);
    expect(decision.required).toBe(true);
    expect(decision.reason).toBe("login_required");
  });
});
