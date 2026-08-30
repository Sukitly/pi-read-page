import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
} from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
  closeMacosBackgroundBrowser,
  createBackgroundPage,
} from "../src/browser/macos-background-browser";

describe("macOS background browser", () => {
  it("closes the externally launched Chrome process through CDP", async () => {
    const send = vi.fn(async () => undefined);
    const session = { send } as unknown as CDPSession;
    const browser = {
      newBrowserCDPSession: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
    } as unknown as Browser;

    await closeMacosBackgroundBrowser(browser);

    expect(send).toHaveBeenCalledWith("Browser.close");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("creates a Chromium target without focusing its window", async () => {
    const page = { url: vi.fn(() => "about:blank") } as unknown as Page;
    let resolvePage!: (page: Page) => void;
    const pagePromise = new Promise<Page>((resolve) => {
      resolvePage = resolve;
    });
    const send = vi.fn(
      async (method: string, _params?: Record<string, unknown>) => {
        if (method === "Target.createTarget") {
          resolvePage(page);
          return { targetId: "target-1" };
        }
        return { success: true };
      },
    );
    const session = {
      send,
      detach: vi.fn(async () => undefined),
    } as unknown as CDPSession;
    const browser = {
      newBrowserCDPSession: vi.fn(async () => session),
    } as unknown as Browser;
    const context = {
      browser: vi.fn(() => browser),
      waitForEvent: vi.fn(() => pagePromise),
    } as unknown as BrowserContext;

    await expect(createBackgroundPage(context)).resolves.toBe(page);

    expect(send).toHaveBeenCalledWith(
      "Target.createTarget",
      expect.objectContaining({
        url: expect.stringMatching(/^about:blank#read-page-/),
        background: true,
        focus: false,
      }),
    );
    expect(session.detach).toHaveBeenCalledTimes(1);
  });
});
