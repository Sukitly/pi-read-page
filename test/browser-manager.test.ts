import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeBrowser,
  getBrowserRuntimeInfo,
  openPage,
  setBrowserAutomationForTest,
} from "../src/browser/browser-manager";

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
});

afterEach(async () => {
  await closeBrowser();
  setBrowserAutomationForTest(undefined);
  process.env = { ...originalEnv };
  await Promise.all(
    profileDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("browser manager lifecycle", () => {
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
    await openedPage.close();
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

  it("removes the temporary profile directory when the persistent profile is locked", async () => {
    await useTemporaryProfileEnv();
    const page = createPage();
    const context = createContext(page);
    launchPersistentContext
      .mockRejectedValueOnce(new Error("profile is already in use"))
      .mockResolvedValueOnce(context);

    const openedPage = await openPage("https://example.com");
    await openedPage.close();
    const runtimeInfo = getBrowserRuntimeInfo();
    expect(runtimeInfo.usingTemporaryProfile).toBe(true);
    expect(runtimeInfo.profileDir).toContain("read-page-profile-");
    await access(runtimeInfo.profileDir || "");

    await closeBrowser();

    await expect(access(runtimeInfo.profileDir || "")).rejects.toThrow();
    expect(context.close).toHaveBeenCalledTimes(1);
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
});
