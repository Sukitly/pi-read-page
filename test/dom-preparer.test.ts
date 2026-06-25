import { describe, expect, it } from "vitest";
import { prepareHtmlForExtraction } from "../src/browser/dom-preparer";

describe("prepareHtmlForExtraction", () => {
  it("keeps structured extraction inputs out of sanitized fallback output", () => {
    const prepared = prepareHtmlForExtraction(
      `<html><head>
        <script type="application/ld+json">{"@type":"Article","headline":"Schema title"}</script>
        <style>.hidden{display:none}</style>
      </head><body><p style="color:red">Visible text</p></body></html>`,
      "https://example.com/article",
    );

    expect(prepared.extractionHtml).toContain('type="application/ld+json"');
    expect(prepared.extractionHtml).toContain(".hidden{display:none}");
    expect(prepared.sanitizedHtml).not.toContain("application/ld+json");
    expect(prepared.sanitizedHtml).not.toContain(".hidden{display:none}");
    expect(prepared.sanitizedHtml).not.toContain('style="color:red"');
    expect(prepared.fallbackDocument.body?.textContent).toContain(
      "Visible text",
    );
  });

  it("inlines captured shadow roots before extraction and output", () => {
    const prepared = prepareHtmlForExtraction(
      `<html><body><my-card data-defuddle-shadow="&lt;h1&gt;Shadow title&lt;/h1&gt;&lt;a href='/path'&gt;Read&lt;/a&gt;">Fallback</my-card></body></html>`,
      "https://example.com/base/page",
    );

    expect(prepared.extractionHtml).toContain("Shadow title");
    expect(prepared.extractionHtml).toContain(
      'href="https://example.com/path"',
    );
    expect(prepared.extractionHtml).not.toContain("data-defuddle-shadow");
    expect(prepared.sanitizedHtml).toContain("Shadow title");
    expect(prepared.sanitizedHtml).not.toContain("data-defuddle-shadow");
    expect(prepared.sanitizedHtml).not.toContain("Fallback");
  });
});
