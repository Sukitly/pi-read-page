import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

let context: BrowserContext | undefined;
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

  const profileDir = expandHome(process.env.WEB_READ_PROFILE_DIR || defaultProfileDir());
  await mkdir(profileDir, { recursive: true });

  try {
    context = await launchPersistent(profileDir);
    activeProfileDir = profileDir;
    usingTemporaryProfile = false;
    return context;
  } catch (error) {
    if (!isProfileInUseError(error) || process.env.WEB_READ_DISABLE_TEMP_PROFILE_FALLBACK === "1") {
      throw error;
    }

    const tempProfileDir = await mkdtemp(join(tmpdir(), "pi-web-read-profile-"));
    context = await launchPersistent(tempProfileDir);
    activeProfileDir = tempProfileDir;
    usingTemporaryProfile = true;
    return context;
  }
}

function launchPersistent(profileDir: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: process.env.WEB_READ_BROWSER_CHANNEL || "chrome",
    executablePath: process.env.WEB_READ_CHROME_PATH || undefined,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

function isProfileInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /existing browser session|profile is already in use|user data directory is already in use/i.test(message);
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
  activeProfileDir = undefined;
  usingTemporaryProfile = false;
  await current?.close().catch(() => undefined);
}

export async function openPage(url: string, signal?: AbortSignal): Promise<Page> {
  if (signal?.aborted) throw new Error("web_read aborted before opening browser");

  const browserContext = await getContext();
  const page = await browserContext.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await settlePage(page, signal);
  return page;
}

export async function settlePage(page: Page, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("web_read aborted while waiting for page");

  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await page.waitForTimeout(750);

  // Read-only lazy-load trigger. No clicks, no typing, no submission.
  await page.evaluate(async () => {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const maxY = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const step = Math.max(600, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < maxY; y += step) {
      window.scrollTo(0, y);
      await delay(80);
    }
    window.scrollTo(0, 0);
  }).catch(() => undefined);

  await page.waitForTimeout(300);
}
