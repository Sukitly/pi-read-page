import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";
import { assertHttpUrlAllowed, isHttpLikeUrl } from "../security/url-policy";
import {
  createBackgroundPage,
  launchMacosBackgroundBrowser,
} from "./macos-background-browser";

type ManagedBrowserContext = {
  browser?: Browser;
  closeBrowserProcess?: () => Promise<void>;
  context: BrowserContext;
  openPagesInBackground: boolean;
  profileDir: string;
  temporaryProfileDir?: string;
};

type LaunchedBrowserContext = Pick<
  ManagedBrowserContext,
  "browser" | "closeBrowserProcess" | "context" | "openPagesInBackground"
>;

type BrowserAutomation = Pick<typeof chromium, "launchPersistentContext">;

type BrowserLease = {
  release: () => Promise<void>;
};

type BrowserLeaseWaiter = {
  resolve: (lease: BrowserLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_IDLE_CLOSE_MS = 500;
const pageLeases = new WeakMap<Page, BrowserLease>();
const browserLeaseWaiters: BrowserLeaseWaiter[] = [];

let browserAutomation: BrowserAutomation = chromium;
let useMacosBackgroundLauncher = true;
let managedContext: ManagedBrowserContext | undefined;
let managedContextPromise: Promise<ManagedBrowserContext> | undefined;
let browserClosePromise: Promise<void> | undefined;
let idleCloseTimer: ReturnType<typeof setTimeout> | undefined;
let activeBrowserLeases = 0;
let contextGeneration = 0;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function defaultProfileDir(): string {
  return resolve(homedir(), ".pi", "agent", "read-page", "browser-profile");
}

async function getContext(
  signal?: AbortSignal,
): Promise<ManagedBrowserContext> {
  throwIfAborted(signal, "read-page aborted before opening browser");
  if (browserClosePromise) {
    await abortable(
      browserClosePromise,
      signal,
      "read-page aborted while waiting for the previous browser to close",
    );
  }
  if (managedContext) return managedContext;

  const generation = contextGeneration;
  if (!managedContextPromise) {
    const pending = createManagedContext();
    managedContextPromise = pending;
    void pending.catch(() => {
      if (managedContextPromise === pending) managedContextPromise = undefined;
    });
  }
  const startup = managedContextPromise;

  try {
    const created = await abortable(
      startup,
      signal,
      "read-page aborted while starting browser",
    );

    if (generation !== contextGeneration) {
      throw new Error("read-page browser context closed during startup");
    }

    managedContext = created;
    return created;
  } catch (error) {
    if (!isAbortError(error) && managedContextPromise === startup) {
      managedContextPromise = undefined;
    }
    throw error;
  }
}

async function createManagedContext(): Promise<ManagedBrowserContext> {
  const profileDir = expandHome(
    process.env.READ_PAGE_PROFILE_DIR || defaultProfileDir(),
  );
  await mkdir(profileDir, { recursive: true });

  try {
    return {
      ...(await launchPersistent(profileDir)),
      profileDir,
    };
  } catch (error) {
    if (
      !isProfileInUseError(error) ||
      process.env.READ_PAGE_DISABLE_TEMP_PROFILE_FALLBACK === "1"
    ) {
      throw error;
    }

    const temporaryProfileDir = await mkdtemp(
      join(tmpdir(), "read-page-profile-"),
    );
    try {
      return {
        ...(await launchPersistent(temporaryProfileDir)),
        profileDir: temporaryProfileDir,
        temporaryProfileDir,
      };
    } catch (tempError) {
      await removeTemporaryProfile(temporaryProfileDir);
      throw tempError;
    }
  }
}

async function launchPersistent(
  profileDir: string,
): Promise<LaunchedBrowserContext> {
  const channel = process.env.READ_PAGE_BROWSER_CHANNEL || "chrome";
  const executablePath = process.env.READ_PAGE_CHROME_PATH || undefined;

  if (
    process.platform === "darwin" &&
    process.env.READ_PAGE_MACOS_BACKGROUND !== "0" &&
    useMacosBackgroundLauncher
  ) {
    const launched = await launchMacosBackgroundBrowser(profileDir, {
      channel,
      executablePath,
    });
    try {
      await installNetworkPolicy(launched.context);
      return {
        browser: launched.browser,
        closeBrowserProcess: launched.close,
        context: launched.context,
        openPagesInBackground: true,
      };
    } catch (error) {
      await launched.close().catch(() => undefined);
      throw error;
    }
  }

  const context = await browserAutomation.launchPersistentContext(profileDir, {
    headless: false,
    channel,
    executablePath,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    await installNetworkPolicy(context);
    return { context, openPagesInBackground: false };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

async function installNetworkPolicy(
  browserContext: BrowserContext,
): Promise<void> {
  await browserContext.route("**/*", async (route) => {
    const url = route.request().url();
    if (!isHttpLikeUrl(url)) {
      await route.continue();
      return;
    }

    try {
      await assertHttpUrlAllowed(url);
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });
}

function isProfileInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /existing browser session|profile is already in use|user data directory is already in use/i.test(
    message,
  );
}

export function setBrowserAutomationForTest(
  automation: BrowserAutomation | undefined,
): void {
  browserAutomation = automation ?? chromium;
  useMacosBackgroundLauncher = automation === undefined;
}

export function getBrowserRuntimeInfo() {
  return {
    profileDir: managedContext?.profileDir,
    usingTemporaryProfile: managedContext?.temporaryProfileDir !== undefined,
  };
}

export async function closeBrowser(): Promise<void> {
  cancelIdleClose();
  if (browserClosePromise) return browserClosePromise;

  const closing = closeBrowserNow();
  browserClosePromise = closing;
  try {
    await closing;
  } finally {
    if (browserClosePromise === closing) browserClosePromise = undefined;
  }
}

async function closeBrowserNow(): Promise<void> {
  contextGeneration += 1;
  const current = managedContext;
  const startup = managedContextPromise;
  managedContext = undefined;
  managedContextPromise = undefined;

  if (current) await closeManagedContext(current);
  if (!startup) return;

  const created = await startup.catch(() => undefined);
  if (created && created.context !== current?.context) {
    await closeManagedContext(created);
  }
}

export async function openPage(
  url: string,
  signal?: AbortSignal,
): Promise<Page> {
  throwIfAborted(signal, "read-page aborted before opening browser");
  const lease = await acquireBrowserLease(signal);
  let page: Page | undefined;
  let handedToCaller = false;

  try {
    await abortable(
      assertHttpUrlAllowed(url),
      signal,
      "read-page aborted while validating URL",
    );
    const managedBrowser = await getContext(signal);
    page = await abortable(
      managedBrowser.openPagesInBackground
        ? createBackgroundPage(managedBrowser.context)
        : managedBrowser.context.newPage(),
      signal,
      "read-page aborted while opening page",
      async (createdPage) => {
        await createdPage.close().catch(() => undefined);
      },
    );

    await abortable(
      page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }),
      signal,
      "read-page aborted while navigating page",
    );
    await abortable(
      assertHttpUrlAllowed(page.url()),
      signal,
      "read-page aborted while validating final URL",
    );
    await settlePage(page, signal);
    await abortable(
      assertHttpUrlAllowed(page.url()),
      signal,
      "read-page aborted while validating settled URL",
    );

    pageLeases.set(page, lease);
    handedToCaller = true;
    return page;
  } finally {
    if (!handedToCaller) {
      await page?.close().catch(() => undefined);
      await lease.release();
    }
  }
}

export async function closePage(page: Page): Promise<void> {
  const lease = pageLeases.get(page);
  pageLeases.delete(page);
  try {
    await page.close().catch(() => undefined);
  } finally {
    await lease?.release();
  }
}

export async function settlePage(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, "read-page aborted while waiting for page");

  await abortable(
    page.waitForLoadState("networkidle", { timeout: 8_000 }),
    signal,
    "read-page aborted while waiting for page",
  ).catch((error) => {
    if (isAbortError(error)) throw error;
  });
  await abortable(
    page.waitForTimeout(750),
    signal,
    "read-page aborted while waiting for page",
  );

  // Read-only lazy-load trigger. No clicks, no typing, no submission.
  await abortable(
    page.evaluate(async () => {
      const delay = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const maxY = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      );
      const step = Math.max(600, Math.floor(window.innerHeight * 0.8));
      for (let y = 0; y < maxY; y += step) {
        window.scrollTo(0, y);
        await delay(80);
      }
      window.scrollTo(0, 0);
    }),
    signal,
    "read-page aborted while preparing page",
  ).catch((error) => {
    if (isAbortError(error)) throw error;
  });

  await abortable(
    page.waitForTimeout(300),
    signal,
    "read-page aborted while waiting for page",
  );
}

async function acquireBrowserLease(
  signal?: AbortSignal,
): Promise<BrowserLease> {
  throwIfAborted(signal, "read-page aborted while waiting for a browser slot");
  cancelIdleClose();

  if (
    activeBrowserLeases < configuredMaxConcurrency() &&
    browserLeaseWaiters.length === 0
  ) {
    activeBrowserLeases += 1;
    return createBrowserLease();
  }

  return new Promise<BrowserLease>((resolve, reject) => {
    const waiter: BrowserLeaseWaiter = { resolve, reject, signal };
    if (signal) {
      waiter.onAbort = () => {
        const index = browserLeaseWaiters.indexOf(waiter);
        if (index >= 0) browserLeaseWaiters.splice(index, 1);
        reject(
          abortError("read-page aborted while waiting for a browser slot"),
        );
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    browserLeaseWaiters.push(waiter);
    if (signal?.aborted) waiter.onAbort?.();
  });
}

function createBrowserLease(): BrowserLease {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;

      let next: BrowserLeaseWaiter | undefined;
      while (browserLeaseWaiters.length > 0 && !next) {
        const candidate = browserLeaseWaiters.shift();
        if (!candidate) break;
        if (candidate.signal?.aborted) {
          candidate.onAbort?.();
          continue;
        }
        next = candidate;
      }

      if (next) {
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener("abort", next.onAbort);
        }
        next.resolve(createBrowserLease());
        return;
      }

      activeBrowserLeases = Math.max(0, activeBrowserLeases - 1);
      if (activeBrowserLeases === 0) scheduleIdleClose();
    },
  };
}

function configuredMaxConcurrency(): number {
  const parsed = Number.parseInt(
    process.env.READ_PAGE_MAX_CONCURRENCY || "",
    10,
  );
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CONCURRENCY;
  return Math.min(16, Math.max(1, parsed));
}

function configuredIdleCloseMs(): number {
  const parsed = Number.parseInt(process.env.READ_PAGE_IDLE_CLOSE_MS || "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_IDLE_CLOSE_MS;
  return Math.min(10_000, Math.max(0, parsed));
}

function cancelIdleClose(): void {
  if (!idleCloseTimer) return;
  clearTimeout(idleCloseTimer);
  idleCloseTimer = undefined;
}

function scheduleIdleClose(): void {
  cancelIdleClose();
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = undefined;
    if (activeBrowserLeases === 0 && browserLeaseWaiters.length === 0) {
      void closeBrowser();
    }
  }, configuredIdleCloseMs());
  idleCloseTimer.unref();
}

async function closeManagedContext(
  browserContext: ManagedBrowserContext,
): Promise<void> {
  if (browserContext.closeBrowserProcess) {
    await browserContext.closeBrowserProcess().catch(() => undefined);
  } else if (browserContext.browser) {
    await browserContext.browser.close().catch(() => undefined);
  } else {
    await browserContext.context.close().catch(() => undefined);
  }
  if (browserContext.temporaryProfileDir) {
    await removeTemporaryProfile(browserContext.temporaryProfileDir);
  }
}

async function removeTemporaryProfile(profileDir: string): Promise<void> {
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  message: string,
): void {
  if (signal?.aborted) throw abortError(message);
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
  cleanup?: (value: T) => Promise<void> | void,
): Promise<T> {
  if (!signal) return promise;

  let aborted = signal.aborted;
  let removeAbortListener: () => void = () => undefined;
  const trackedPromise = promise.then((value) => {
    if (aborted && cleanup) {
      void Promise.resolve(cleanup(value)).catch(() => undefined);
    }
    return value;
  });
  void trackedPromise.catch(() => undefined);

  if (aborted) throw abortError(message);

  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      aborted = true;
      reject(abortError(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => {
      signal.removeEventListener("abort", onAbort);
    };
  });

  try {
    return await Promise.race([trackedPromise, abortPromise]);
  } finally {
    removeAbortListener();
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
