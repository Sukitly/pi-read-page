import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import type { ManagedPage } from "../src/browser/browser-manager";
import { extractWithOptionalUserAction } from "../src/tools/read-page";
import type { ExtractedPage } from "../src/types";

function extractedPage(url: string): ExtractedPage {
  return {
    url,
    title: "Example",
    markdown: "hello",
    contentHtml: "<p>hello</p>",
    fullHtml: "<html><body><p>hello</p></body></html>",
    textLength: 5,
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
      wordCount: 1,
      parseTime: 0,
      metaTags: [],
      variables: {},
    },
    confidence: { level: "high", score: 100, reasons: [] },
    warnings: [],
  };
}

function createPage(url = "https://example.com/") {
  return {
    url: vi.fn(() => url),
    bringToFront: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Page;
}

function createManagedPage(
  page: Page,
  browserProfile: ManagedPage["browserProfile"] = "persistent",
): ManagedPage {
  return {
    browserProfile,
    close: vi.fn(async () => page.close()),
    page,
  };
}

function createContext() {
  return { hasUI: false } as unknown as ExtensionContext;
}

describe("read-page tool browser lifecycle", () => {
  it("closes its page lease after a successful extraction", async () => {
    const url = "https://example.com/";
    const page = createPage(url);
    const managedPage = createManagedPage(page, "temporary");
    const closePage = vi.fn(async (opened: ManagedPage) => opened.close());

    const result = await extractWithOptionalUserAction(
      url,
      undefined,
      undefined,
      createContext(),
      {
        openPage: vi.fn(async () => managedPage),
        closePage,
        settlePage: vi.fn(async () => undefined),
        extractMarkdown: vi.fn(async () => extractedPage(url)),
        decideUserAction: vi.fn(() => ({
          required: false,
          confidence: { level: "high", score: 100, reasons: [] },
        })),
        waitForUserAction: vi.fn(async () => false),
      },
    );

    expect(page.close).toHaveBeenCalledTimes(1);
    expect(closePage).toHaveBeenCalledWith(managedPage);
    expect(result.browserProfile).toBe("temporary");
  });

  it("keeps the same page open during user handoff, then closes its lease after re-extraction", async () => {
    const url = "https://example.com/login";
    const page = createPage(url);
    const managedPage = createManagedPage(page);
    const closePage = vi.fn(async (opened: ManagedPage) => opened.close());
    const settlePage = vi.fn(async () => undefined);
    const extractMarkdown = vi
      .fn()
      .mockResolvedValueOnce(extractedPage(url))
      .mockResolvedValueOnce(extractedPage(url));
    const decideUserAction = vi
      .fn()
      .mockReturnValueOnce({
        required: true,
        reason: "login_required",
        message: "Login required.",
        confidence: { level: "low", score: 10, reasons: [] },
      })
      .mockReturnValueOnce({
        required: false,
        confidence: { level: "high", score: 100, reasons: [] },
      });
    const waitForUserAction = vi.fn(async () => {
      expect(page.close).not.toHaveBeenCalled();
      expect(closePage).not.toHaveBeenCalled();
      return true;
    });

    await extractWithOptionalUserAction(
      url,
      undefined,
      undefined,
      createContext(),
      {
        openPage: vi.fn(async () => managedPage),
        closePage,
        settlePage,
        extractMarkdown,
        decideUserAction,
        waitForUserAction,
      },
    );

    expect(waitForUserAction).toHaveBeenCalledTimes(1);
    expect(settlePage).toHaveBeenCalledWith(page, undefined);
    expect(extractMarkdown).toHaveBeenCalledTimes(2);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(closePage).toHaveBeenCalledWith(managedPage);
  });

  it("does not close a page lease when opening the page fails", async () => {
    const closePage = vi.fn(async (opened: ManagedPage) => opened.close());

    await expect(
      extractWithOptionalUserAction(
        "https://example.com/",
        undefined,
        undefined,
        createContext(),
        {
          openPage: vi.fn(async () => {
            throw new Error("open failed");
          }),
          closePage,
          settlePage: vi.fn(async () => undefined),
          extractMarkdown: vi.fn(async () =>
            extractedPage("https://example.com/"),
          ),
          decideUserAction: vi.fn(() => ({
            required: false,
            confidence: { level: "high", score: 100, reasons: [] },
          })),
          waitForUserAction: vi.fn(async () => false),
        },
      ),
    ).rejects.toThrow(/open failed/);

    expect(closePage).not.toHaveBeenCalled();
  });
});
