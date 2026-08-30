import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, CDPSession } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeBrowser,
  closePage,
  openPage,
  setBrowserAutomationForTest,
  setMacosBackgroundLauncherForTest,
} from "../src/browser/browser-manager";
import { MacosBackgroundBrowserError } from "../src/browser/macos-background-browser";

const originalEnv = { ...process.env };
let launchPersistentContext = vi.fn();
let profileDirs: string[] = [];

function createPage(overrides: Record<string, unknown> = {}) {
  return {
    url: vi.fn(() => "https://example.com/"),
    goto: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createContext(
  page = createPage(),
  overrides: Record<string, unknown> = {},
) {
  return {
    route: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createBackgroundLaunch(page = createPage()) {
  const send = vi.fn(async (method: string) => {
    if (method === "Target.createTarget") return { targetId: "target-1" };
    return {};
  });
  const session = {
    send,
    detach: vi.fn(async () => undefined),
  } as unknown as CDPSession;
  const browser = {
    newBrowserCDPSession: vi.fn(async () => session),
  } as unknown as Browser;
  const context = createContext(page, {
    browser: vi.fn(() => browser),
    waitForEvent: vi.fn(async () => page),
  });
  return {
    browser,
    close: vi.fn(async () => undefined),
    context,
    page,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForExpectation(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 1_000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function useTemporaryProfileEnv() {
  const profileDir = await mkdtemp(
    path.join(tmpdir(), "read-page-test-profile-"),
  );
  profileDirs.push(profileDir);
  process.env.READ_PAGE_PROFILE_DIR = profileDir;
  process.env.READ_PAGE_ALLOW_PRIVATE_NETWORK = "1";
  delete process.env.READ_PAGE_DISABLE_TEMP_PROFILE_FALLBACK;
  return profileDir;
}

beforeEach(async () => {
  await closeBrowser();
  process.env = { ...originalEnv };
  profileDirs = [];
  launchPersistentContext = vi.fn();
  setBrowserAutomationForTest({
    launchPersistentContext: launchPersistentContext as never,
  });
  setMacosBackgroundLauncherForTest(null);
});

afterEach(async () => {
  await closeBrowser();
  setBrowserAutomationForTest(undefined);
  setMacosBackgroundLauncherForTest(undefined);
  process.env = { ...originalEnv };
  await Promise.all(
    profileDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("browser manager lifecycle", () => {
  it("uses Playwright's direct headed launcher when background launch is explicitly disabled", async () => {
    const profileDir = await useTemporaryProfileEnv();
    const page = createPage();
    const context = createContext(page);
    launchPersistentContext.mockResolvedValue(context);

    const openedPage = await openPage("https://example.com");
    await closePage(openedPage);

    expect(launchPersistentContext).toHaveBeenCalledWith(
      profileDir,
      expect.objectContaining({
        headless: false,
        args: ["--disable-blink-features=AutomationControlled"],
      }),
    );
  });

  it("uses the injected macOS background launcher when explicitly enabled", async () => {
    const profileDir = await useTemporaryProfileEnv();
    const launched = createBackgroundLaunch();
    const backgroundLauncher = vi.fn(async () => launched);
    setMacosBackgroundLauncherForTest(backgroundLauncher as never);

    const openedPage = await openPage("https://example.com");

    expect(backgroundLauncher).toHaveBeenCalledWith(
      profileDir,
      expect.objectContaining({ channel: "chrome" }),
    );
    expect(launched.context.newPage).not.toHaveBeenCalled();
    expect(launched.browser.newBrowserCDPSession).toHaveBeenCalledTimes(1);
    expect(openedPage.page).toBe(launched.page);

    await closePage(openedPage);
    await closeBrowser();
    expect(launched.close).toHaveBeenCalledTimes(1);
  });

  it("does not use a temporary profile for a background startup timeout", async () => {
    await useTemporaryProfileEnv();
    const backgroundLauncher = vi.fn(async () => {
      throw new MacosBackgroundBrowserError(
        "STARTUP_TIMEOUT",
        "background startup timed out",
      );
    });
    setMacosBackgroundLauncherForTest(backgroundLauncher as never);

    await expect(openPage("https://example.com")).rejects.toThrow(
      /startup timed out/,
    );

    expect(backgroundLauncher).toHaveBeenCalledTimes(1);
    expect(launchPersistentContext).not.toHaveBeenCalled();
  });

  it("shares one browser across concurrent pages and closes it after the final lease", async () => {
    await useTemporaryProfileEnv();
    process.env.READ_PAGE_IDLE_CLOSE_MS = "10";
    const firstPage = createPage();
    const secondPage = createPage();
    const context = createContext(firstPage, {
      newPage: vi
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(secondPage),
    });
    launchPersistentContext.mockResolvedValue(context);

    const [openedFirst, openedSecond] = await Promise.all([
      openPage("https://example.com/first"),
      openPage("https://example.com/second"),
    ]);

    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    expect(context.newPage).toHaveBeenCalledTimes(2);

    await closePage(openedFirst);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.close).not.toHaveBeenCalled();

    await closePage(openedSecond);
    await waitForExpectation(() =>
      expect(context.close).toHaveBeenCalledTimes(1),
    );
  });

  it("limits concurrent browser pages without serializing the tool", async () => {
    await useTemporaryProfileEnv();
    process.env.READ_PAGE_MAX_CONCURRENCY = "2";
    const firstPage = createPage();
    const secondPage = createPage();
    const thirdPage = createPage();
    const context = createContext(firstPage, {
      newPage: vi
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(secondPage)
        .mockResolvedValueOnce(thirdPage),
    });
    launchPersistentContext.mockResolvedValue(context);

    const first = openPage("https://example.com/first");
    const second = openPage("https://example.com/second");
    const third = openPage("https://example.com/third");
    const [openedFirst, openedSecond] = await Promise.all([first, second]);
    expect(context.newPage).toHaveBeenCalledTimes(2);

    await closePage(openedFirst);
    const openedThird = await third;
    expect(context.newPage).toHaveBeenCalledTimes(3);

    await Promise.all([closePage(openedSecond), closePage(openedThird)]);
  });

  it("removes an aborted queued page and grants the next waiter", async () => {
    await useTemporaryProfileEnv();
    process.env.READ_PAGE_MAX_CONCURRENCY = "1";
    const firstPage = createPage();
    const thirdPage = createPage();
    const context = createContext(firstPage, {
      newPage: vi
        .fn()
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce(thirdPage),
    });
    launchPersistentContext.mockResolvedValue(context);
    const controller = new AbortController();

    const first = await openPage("https://example.com/first");
    const aborted = openPage("https://1.1.1.1/aborted", controller.signal);
    void aborted.catch(() => undefined);
    const third = openPage("https://8.8.8.8/third");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(aborted).rejects.toThrow(/waiting for a browser slot/);
    expect(context.newPage).toHaveBeenCalledTimes(1);

    await closePage(first);
    const openedThird = await third;
    expect(openedThird.page).toBe(thirdPage);
    expect(context.newPage).toHaveBeenCalledTimes(2);
    await closePage(openedThird);
  });

  it("rejects a disallowed URL before waiting for a browser lease", async () => {
    await useTemporaryProfileEnv();
    process.env.READ_PAGE_MAX_CONCURRENCY = "1";
    const page = createPage();
    const context = createContext(page);
    launchPersistentContext.mockResolvedValue(context);
    const first = await openPage("https://example.com/first");

    await expect(openPage("file:///tmp/secret")).rejects.toThrow(
      /Only http:\/\/ and https:\/\//,
    );
    expect(context.newPage).toHaveBeenCalledTimes(1);

    await closePage(first);
  });

  it("closes an opened page when navigation fails before handing it to the caller", async () => {
    await useTemporaryProfileEnv();
    const page = createPage({
      goto: vi.fn(async () => {
        throw new Error("navigation failed");
      }),
    });
    const context = createContext(page);
    launchPersistentContext.mockResolvedValue(context);

    await expect(openPage("https://example.com")).rejects.toThrow(
      /navigation failed/,
    );

    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it("closes the active browser context", async () => {
    await useTemporaryProfileEnv();
    const page = createPage();
    const context = createContext(page);
    launchPersistentContext.mockResolvedValue(context);

    const openedPage = await openPage("https://example.com");
    await closePage(openedPage);
    await closeBrowser();

    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("closes a browser context that finishes starting after closeBrowser is called", async () => {
    await useTemporaryProfileEnv();
    const page = createPage();
    const context = createContext(page);
    const startup = deferred<typeof context>();
    launchPersistentContext.mockReturnValue(startup.promise);

    const openPromise = openPage("https://example.com");
    void openPromise.catch(() => undefined);
    await waitForExpectation(() =>
      expect(launchPersistentContext).toHaveBeenCalled(),
    );

    const closePromise = closeBrowser();
    startup.resolve(context);

    await closePromise;
    await expect(openPromise).rejects.toThrow(/closed during startup/);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up a browser context that starts after the operation is aborted", async () => {
    await useTemporaryProfileEnv();
    const page = createPage();
    const context = createContext(page);
    const startup = deferred<typeof context>();
    launchPersistentContext.mockReturnValue(startup.promise);
    const controller = new AbortController();

    const openPromise = openPage("https://example.com", controller.signal);
    void openPromise.catch(() => undefined);
    await waitForExpectation(() =>
      expect(launchPersistentContext).toHaveBeenCalled(),
    );
    controller.abort();

    await expect(openPromise).rejects.toThrow(/starting browser/);
    startup.resolve(context);
    await waitForExpectation(() =>
      expect(context.close).toHaveBeenCalledTimes(1),
    );
  });

  it("does not close shared startup when one concurrent caller aborts", async () => {
    await useTemporaryProfileEnv();
    const page = createPage();
    const context = createContext(page);
    const startup = deferred<typeof context>();
    launchPersistentContext.mockReturnValue(startup.promise);
    const controller = new AbortController();

    const abortedOpen = openPage(
      "https://example.com/aborted",
      controller.signal,
    );
    const survivingOpen = openPage("https://example.com/surviving");
    void abortedOpen.catch(() => undefined);
    await waitForExpectation(() =>
      expect(launchPersistentContext).toHaveBeenCalledTimes(1),
    );
    controller.abort();

    await expect(abortedOpen).rejects.toThrow(/starting browser/);
    startup.resolve(context);
    const survivingPage = await survivingOpen;
    expect(context.close).not.toHaveBeenCalled();

    await closePage(survivingPage);
  });

  it("closes a late-created page when the operation is aborted while opening it", async () => {
    await useTemporaryProfileEnv();
    const page = createPage();
    const newPage = deferred<typeof page>();
    const context = createContext(page, {
      newPage: vi.fn(() => newPage.promise),
    });
    launchPersistentContext.mockResolvedValue(context);
    const controller = new AbortController();

    const openPromise = openPage("https://example.com", controller.signal);
    void openPromise.catch(() => undefined);
    await waitForExpectation(() => expect(context.newPage).toHaveBeenCalled());
    controller.abort();

    await expect(openPromise).rejects.toThrow(/opening page/);
    newPage.resolve(page);
    await waitForExpectation(() => expect(page.close).toHaveBeenCalledTimes(1));
  });

  it("uses a temporary profile for a structured background profile lock", async () => {
    await useTemporaryProfileEnv();
    const launched = createBackgroundLaunch();
    const backgroundLauncher = vi
      .fn()
      .mockRejectedValueOnce(
        new MacosBackgroundBrowserError(
          "PROFILE_IN_USE",
          "profile is already in use",
        ),
      )
      .mockResolvedValueOnce(launched);
    setMacosBackgroundLauncherForTest(backgroundLauncher as never);

    const openedPage = await openPage("https://example.com");
    const temporaryProfileDir = String(backgroundLauncher.mock.calls[1]?.[0]);
    expect(openedPage.browserProfile).toBe("temporary");
    expect(temporaryProfileDir).toContain("read-page-profile-");
    await access(temporaryProfileDir);

    await closePage(openedPage);
    await closeBrowser();

    await expect(access(temporaryProfileDir)).rejects.toThrow();
    expect(backgroundLauncher).toHaveBeenCalledTimes(2);
    expect(launched.close).toHaveBeenCalledTimes(1);
  });

  it("removes the temporary profile directory when Playwright reports a locked profile", async () => {
    await useTemporaryProfileEnv();
    const page = createPage();
    const context = createContext(page);
    launchPersistentContext
      .mockRejectedValueOnce(new Error("profile is already in use"))
      .mockResolvedValueOnce(context);

    const openedPage = await openPage("https://example.com");
    await closePage(openedPage);
    const temporaryProfileDir = String(
      launchPersistentContext.mock.calls[1]?.[0],
    );
    expect(openedPage.browserProfile).toBe("temporary");
    expect(temporaryProfileDir).toContain("read-page-profile-");
    await access(temporaryProfileDir);

    await closeBrowser();

    await expect(access(temporaryProfileDir)).rejects.toThrow();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a temporary profile when browser shutdown is not confirmed", async () => {
    await useTemporaryProfileEnv();
    const page = createPage();
    const context = createContext(page, {
      close: vi.fn(async () => {
        throw new Error("close failed");
      }),
    });
    launchPersistentContext
      .mockRejectedValueOnce(new Error("profile is already in use"))
      .mockResolvedValueOnce(context);

    const openedPage = await openPage("https://example.com");
    const temporaryProfileDir = String(
      launchPersistentContext.mock.calls[1]?.[0],
    );
    profileDirs.push(temporaryProfileDir);
    await closePage(openedPage);

    await expect(closeBrowser()).rejects.toThrow(/close failed/);
    await access(temporaryProfileDir);
  });

  it("keeps a temporary profile when launch cleanup is not confirmed", async () => {
    await useTemporaryProfileEnv();
    const page = createPage();
    const context = createContext(page, {
      route: vi.fn(async () => {
        throw new Error("route failed");
      }),
      close: vi.fn(async () => {
        throw new Error("close failed");
      }),
    });
    launchPersistentContext
      .mockRejectedValueOnce(new Error("profile is already in use"))
      .mockResolvedValueOnce(context);

    await expect(openPage("https://example.com")).rejects.toMatchObject({
      code: "CLEANUP_UNCONFIRMED",
    });
    const temporaryProfileDir = String(
      launchPersistentContext.mock.calls[1]?.[0],
    );
    profileDirs.push(temporaryProfileDir);
    await access(temporaryProfileDir);
  });

  it("surfaces background cleanup failure after network policy installation fails", async () => {
    await useTemporaryProfileEnv();
    const launched = createBackgroundLaunch();
    launched.context.route.mockRejectedValue(new Error("route failed"));
    launched.close.mockRejectedValue(new Error("cleanup failed"));
    setMacosBackgroundLauncherForTest(vi.fn(async () => launched) as never);

    await expect(openPage("https://example.com")).rejects.toMatchObject({
      code: "CLEANUP_UNCONFIRMED",
    });
    expect(launched.close).toHaveBeenCalledTimes(1);
  });

  it("closes the browser context if network policy installation fails", async () => {
    await useTemporaryProfileEnv();
    const page = createPage();
    const context = createContext(page, {
      route: vi.fn(async () => {
        throw new Error("route failed");
      }),
    });
    launchPersistentContext.mockResolvedValue(context);

    await expect(openPage("https://example.com")).rejects.toThrow(
      /route failed/,
    );
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces direct context cleanup failure after network policy installation fails", async () => {
    await useTemporaryProfileEnv();
    const page = createPage();
    const context = createContext(page, {
      route: vi.fn(async () => {
        throw new Error("route failed");
      }),
      close: vi.fn(async () => {
        throw new Error("close failed");
      }),
    });
    launchPersistentContext.mockResolvedValue(context);

    await expect(openPage("https://example.com")).rejects.toThrow(
      /context could not be closed/,
    );
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
