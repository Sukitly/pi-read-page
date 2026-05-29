import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";
import { assertHttpUrlAllowed, isHttpLikeUrl } from "../security/url-policy";

let context: BrowserContext | undefined;
let contextPromise: Promise<BrowserContext> | undefined;
let activeProfileDir: string | undefined;
let usingTemporaryProfile = false;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function defaultProfileDir(): string {
  return resolve(homedir(), ".pi", "agent", "web-read", "browser-profile");
}

async function getContext(): Promise<BrowserContext> {
  if (context) return context;
  contextPromise ??= createContext();

  try {
    context = await contextPromise;
    return context;
  } catch (error) {
    contextPromise = undefined;
    throw error;
  }
}

async function createContext(): Promise<BrowserContext> {
  const profileDir = expandHome(
    process.env.WEB_READ_PROFILE_DIR || defaultProfileDir(),
  );
  await mkdir(profileDir, { recursive: true });

  try {
    const browserContext = await launchPersistent(profileDir);
    activeProfileDir = profileDir;
    usingTemporaryProfile = false;
    return browserContext;
  } catch (error) {
    if (
      !isProfileInUseError(error) ||
      process.env.WEB_READ_DISABLE_TEMP_PROFILE_FALLBACK === "1"
    ) {
      throw error;
    }

    const tempProfileDir = await mkdtemp(
      join(tmpdir(), "pi-web-read-profile-"),
    );
    const browserContext = await launchPersistent(tempProfileDir);
    activeProfileDir = tempProfileDir;
    usingTemporaryProfile = true;
    return browserContext;
  }
}

async function launchPersistent(profileDir: string): Promise<BrowserContext> {
  const browserContext = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: process.env.WEB_READ_BROWSER_CHANNEL || "chrome",
    executablePath: process.env.WEB_READ_CHROME_PATH || undefined,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  await installNetworkPolicy(browserContext);
  return browserContext;
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

export function getBrowserRuntimeInfo() {
  return {
    profileDir: activeProfileDir,
    usingTemporaryProfile,
  };
}

export async function closeBrowser(): Promise<void> {
  const current = context;
  context = undefined;
  contextPromise = undefined;
  activeProfileDir = undefined;
  usingTemporaryProfile = false;
  await current?.close().catch(() => undefined);
}

export async function openPage(
  url: string,
  signal?: AbortSignal,
): Promise<Page> {
  if (signal?.aborted)
    throw new Error("web_read aborted before opening browser");

  await assertHttpUrlAllowed(url);
  const browserContext = await getContext();
  const page = await browserContext.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await assertHttpUrlAllowed(page.url());
  await settlePage(page, signal);
  await assertHttpUrlAllowed(page.url());
  return page;
}

export async function settlePage(
  page: Page,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    throw new Error("web_read aborted while waiting for page");

  await page
    .waitForLoadState("networkidle", { timeout: 8_000 })
    .catch(() => undefined);
  await page.waitForTimeout(750);

  // Read-only lazy-load trigger. No clicks, no typing, no submission.
  await page
    .evaluate(async () => {
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
    })
    .catch(() => undefined);

  await page.waitForTimeout(300);
}
