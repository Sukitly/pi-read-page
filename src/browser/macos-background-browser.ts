import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";

const execFileAsync = promisify(execFile);
const DEVTOOLS_STARTUP_TIMEOUT_MS = 10_000;
const DEVTOOLS_POLL_INTERVAL_MS = 50;

const CHANNEL_APP_NAMES: Record<string, string> = {
  chrome: "Google Chrome",
  "chrome-beta": "Google Chrome Beta",
  "chrome-dev": "Google Chrome Dev",
  "chrome-canary": "Google Chrome Canary",
  chromium: "Chromium",
  msedge: "Microsoft Edge",
  "msedge-beta": "Microsoft Edge Beta",
  "msedge-dev": "Microsoft Edge Dev",
  "msedge-canary": "Microsoft Edge Canary",
};

type DevToolsPortSnapshot = {
  content: string;
  modifiedAt: number;
};

export type BackgroundBrowserContext = {
  browser: Browser;
  close: () => Promise<void>;
  context: BrowserContext;
};

export async function launchMacosBackgroundBrowser(
  profileDir: string,
  options: { channel: string; executablePath?: string },
): Promise<BackgroundBrowserContext> {
  const portFile = join(profileDir, "DevToolsActivePort");
  const previousPortFile = await readPortSnapshot(portFile);
  const appArguments = resolveAppArguments(
    options.channel,
    options.executablePath,
  );

  await execFileAsync("/usr/bin/open", [
    "-g",
    "-n",
    ...appArguments,
    "--args",
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-blink-features=AutomationControlled",
    "about:blank",
  ]);

  const port = await waitForDevToolsPort(portFile, previousPortFile);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
    timeout: DEVTOOLS_STARTUP_TIMEOUT_MS,
  });
  const context = browser.contexts()[0];

  if (!context) {
    await closeMacosBackgroundBrowser(browser).catch(() => undefined);
    throw new Error("Background Chrome did not expose its persistent context");
  }

  return {
    browser,
    close: () => closeMacosBackgroundBrowser(browser),
    context,
  };
}

export async function closeMacosBackgroundBrowser(
  browser: Browser,
): Promise<void> {
  try {
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.close");
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export async function createBackgroundPage(
  browserContext: BrowserContext,
): Promise<Page> {
  const browser = browserContext.browser();
  if (!browser) {
    throw new Error(
      "Cannot create a background page without a Chromium browser",
    );
  }

  const session = await browser.newBrowserCDPSession();
  const markerUrl = `about:blank#read-page-${randomUUID()}`;
  const pagePromise = browserContext.waitForEvent("page", {
    predicate: (page) => page.url() === markerUrl,
    timeout: 10_000,
  });
  void pagePromise.catch(() => undefined);

  let targetId: string | undefined;
  try {
    const created = await session.send("Target.createTarget", {
      url: markerUrl,
      background: true,
      focus: false,
    });
    targetId = created.targetId;
    return await pagePromise;
  } catch (error) {
    if (targetId) {
      await session
        .send("Target.closeTarget", { targetId })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

function resolveAppArguments(
  channel: string,
  executablePath: string | undefined,
): string[] {
  if (executablePath) {
    const appBundle = executablePath.match(/^(.+?\.app)(?:\/.*)?$/i)?.[1];
    if (!appBundle) {
      throw new Error(
        "READ_PAGE_CHROME_PATH must point inside a macOS .app bundle when background launch is enabled. Set READ_PAGE_MACOS_BACKGROUND=0 to use Playwright's direct launcher.",
      );
    }
    return [appBundle];
  }

  return ["-a", CHANNEL_APP_NAMES[channel] || channel];
}

async function waitForDevToolsPort(
  portFile: string,
  previous: DevToolsPortSnapshot | undefined,
): Promise<number> {
  const deadline = Date.now() + DEVTOOLS_STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const current = await readPortSnapshot(portFile);
    if (
      current &&
      (!previous ||
        current.content !== previous.content ||
        current.modifiedAt !== previous.modifiedAt)
    ) {
      const port = Number.parseInt(
        current.content.split(/\r?\n/, 1)[0] || "",
        10,
      );
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, DEVTOOLS_POLL_INTERVAL_MS),
    );
  }

  throw new Error(
    "Chrome profile is already in use or background Chrome did not expose a DevTools port before timeout",
  );
}

async function readPortSnapshot(
  portFile: string,
): Promise<DevToolsPortSnapshot | undefined> {
  try {
    const [content, fileStat] = await Promise.all([
      readFile(portFile, "utf8"),
      stat(portFile),
    ]);
    return { content, modifiedAt: fileStat.mtimeMs };
  } catch {
    return undefined;
  }
}
