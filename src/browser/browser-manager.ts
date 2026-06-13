import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";
import { assertHttpUrlAllowed, isHttpLikeUrl } from "../security/url-policy";

type ManagedBrowserContext = {
  context: BrowserContext;
  profileDir: string;
  temporaryProfileDir?: string;
};

type BrowserAutomation = Pick<typeof chromium, "launchPersistentContext">;

let browserAutomation: BrowserAutomation = chromium;
let managedContext: ManagedBrowserContext | undefined;
let managedContextPromise: Promise<ManagedBrowserContext> | undefined;
let contextGeneration = 0;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function defaultProfileDir(): string {
  return resolve(homedir(), ".pi", "agent", "read-page", "browser-profile");
}

async function getContext(signal?: AbortSignal): Promise<BrowserContext> {
  throwIfAborted(signal, "read-page aborted before opening browser");
  if (managedContext) return managedContext.context;

  const generation = contextGeneration;
  if (!managedContextPromise) managedContextPromise = createManagedContext();
  const startup = managedContextPromise;

  try {
    const created = await abortable(
      startup,
      signal,
      "read-page aborted while starting browser",
      closeManagedContext,
    );

    if (generation !== contextGeneration) {
      throw new Error("read-page browser context closed during startup");
    }

    managedContext = created;
    return created.context;
  } catch (error) {
    if (managedContextPromise === startup) managedContextPromise = undefined;
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
      context: await launchPersistent(profileDir),
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
        context: await launchPersistent(temporaryProfileDir),
        profileDir: temporaryProfileDir,
        temporaryProfileDir,
      };
    } catch (tempError) {
      await removeTemporaryProfile(temporaryProfileDir);
      throw tempError;
    }
  }
}

async function launchPersistent(profileDir: string): Promise<BrowserContext> {
  const browserContext = await browserAutomation.launchPersistentContext(
    profileDir,
    {
      headless: false,
      channel: process.env.READ_PAGE_BROWSER_CHANNEL || "chrome",
      executablePath: process.env.READ_PAGE_CHROME_PATH || undefined,
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled"],
    },
  );

  try {
    await installNetworkPolicy(browserContext);
    return browserContext;
  } catch (error) {
    await browserContext.close().catch(() => undefined);
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
}

export function getBrowserRuntimeInfo() {
  return {
    profileDir: managedContext?.profileDir,
    usingTemporaryProfile: managedContext?.temporaryProfileDir !== undefined,
  };
}

export async function closeBrowser(): Promise<void> {
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

  await abortable(
    assertHttpUrlAllowed(url),
    signal,
    "read-page aborted while validating URL",
  );
  const browserContext = await getContext(signal);
  const page = await abortable(
    browserContext.newPage(),
    signal,
    "read-page aborted while opening page",
    async (createdPage) => {
      await createdPage.close().catch(() => undefined);
    },
  );

  let shouldClosePage = true;
  try {
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
    shouldClosePage = false;
    return page;
  } finally {
    if (shouldClosePage) await page.close().catch(() => undefined);
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

async function closeManagedContext(
  browserContext: ManagedBrowserContext,
): Promise<void> {
  await browserContext.context.close().catch(() => undefined);
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
