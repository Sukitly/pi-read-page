import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";
import {
  BrowserLifecycleError,
  type BrowserLifecycleErrorCode,
} from "./browser-errors";

const execFileAsync = promisify(execFile);
const DEVTOOLS_STARTUP_TIMEOUT_MS = 10_000;
const DEVTOOLS_POLL_INTERVAL_MS = 50;
const PROCESS_SHUTDOWN_TIMEOUT_MS = 2_000;

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

export type MacosBackgroundBrowserErrorCode = BrowserLifecycleErrorCode;
export const MacosBackgroundBrowserError = BrowserLifecycleError;

export type DevToolsPortSnapshot = {
  content: string;
  modifiedAt: number;
};

type BrowserProcess = {
  command: string;
  executable: string;
  pid: number;
};

export type MacosBackgroundBrowserDependencies = {
  connectOverCDP: (endpoint: string, timeoutMs: number) => Promise<Browser>;
  findListeningProcessIds: (port: number) => Promise<number[]>;
  isProcessRunning: (pid: number) => boolean;
  listProcesses: () => Promise<BrowserProcess[]>;
  now: () => number;
  openApplication: (args: string[]) => Promise<void>;
  pollIntervalMs: number;
  randomId: () => string;
  readPortSnapshot: (
    portFile: string,
  ) => Promise<DevToolsPortSnapshot | undefined>;
  shutdownTimeoutMs: number;
  signalProcess: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  startupTimeoutMs: number;
};

export type BackgroundBrowserContext = {
  browser: Browser;
  close: () => Promise<void>;
  context: BrowserContext;
};

type OwnedBrowserProcess = {
  baselineProcessIds: Set<number>;
  confirmed: boolean;
  executableName: string;
  launchToken: string;
  port?: number;
  profileArgument: string;
};

type BrowserLaunchOptions = {
  channel: string;
  executablePath?: string;
};

const defaultDependencies: MacosBackgroundBrowserDependencies = {
  connectOverCDP: (endpoint, timeoutMs) =>
    chromium.connectOverCDP(endpoint, { timeout: timeoutMs }),
  findListeningProcessIds: findListeningProcessIds,
  isProcessRunning,
  listProcesses,
  now: Date.now,
  openApplication: async (args) => {
    await execFileAsync("/usr/bin/open", args);
  },
  pollIntervalMs: DEVTOOLS_POLL_INTERVAL_MS,
  randomId: randomUUID,
  readPortSnapshot,
  shutdownTimeoutMs: PROCESS_SHUTDOWN_TIMEOUT_MS,
  signalProcess: async (pid, signal) => {
    process.kill(pid, signal);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  startupTimeoutMs: DEVTOOLS_STARTUP_TIMEOUT_MS,
};

export const launchMacosBackgroundBrowser =
  createMacosBackgroundBrowserLauncher();

export function createMacosBackgroundBrowserLauncher(
  overrides: Partial<MacosBackgroundBrowserDependencies> = {},
): (
  profileDir: string,
  options: BrowserLaunchOptions,
) => Promise<BackgroundBrowserContext> {
  const dependencies = { ...defaultDependencies, ...overrides };
  return (profileDir, options) =>
    launchBackgroundBrowser(profileDir, options, dependencies);
}

async function launchBackgroundBrowser(
  profileDir: string,
  options: BrowserLaunchOptions,
  dependencies: MacosBackgroundBrowserDependencies,
): Promise<BackgroundBrowserContext> {
  const portFile = join(profileDir, "DevToolsActivePort");
  const previousPortFile = await dependencies.readPortSnapshot(portFile);
  const app = resolveApp(options.channel, options.executablePath);
  const profileArgument = `--user-data-dir=${profileDir}`;
  const processesBeforeLaunch = await dependencies.listProcesses();
  const existingOwners = findBrowserProcessesWithArgument(
    processesBeforeLaunch,
    profileArgument,
    app.executableName,
  );
  if (existingOwners.length > 0) {
    throw new MacosBackgroundBrowserError(
      "PROFILE_IN_USE",
      `Chrome profile is already in use: ${profileDir}`,
    );
  }

  const launchToken = dependencies.randomId();
  const launchTokenArgument = `--read-page-launch-token=${launchToken}`;
  const ownedProcess: OwnedBrowserProcess = {
    baselineProcessIds: new Set(
      findBrowserProcesses(processesBeforeLaunch, app.executableName).map(
        (process) => process.pid,
      ),
    ),
    confirmed: false,
    executableName: app.executableName,
    launchToken,
    profileArgument,
  };
  let browser: Browser | undefined;
  let launchAttempted = false;

  try {
    launchAttempted = true;
    try {
      await dependencies.openApplication([
        "-g",
        "-n",
        ...app.openArguments,
        "--args",
        profileArgument,
        launchTokenArgument,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-blink-features=AutomationControlled",
        "about:blank",
      ]);
    } catch (error) {
      throw new MacosBackgroundBrowserError(
        "BACKGROUND_LAUNCH_FAILED",
        "Launch Services could not open background Chrome",
        { cause: error },
      );
    }

    const port = await waitForDevToolsPort(
      portFile,
      previousPortFile,
      dependencies,
    );
    ownedProcess.port = port;
    await findOwnedProcessIds(ownedProcess, dependencies);

    try {
      browser = await dependencies.connectOverCDP(
        `http://127.0.0.1:${port}`,
        dependencies.startupTimeoutMs,
      );
    } catch (error) {
      throw new MacosBackgroundBrowserError(
        "CDP_CONNECT_FAILED",
        `Background Chrome exposed port ${port}, but Playwright could not connect over CDP`,
        { cause: error },
      );
    }

    const context = browser.contexts()[0];
    if (!context) {
      throw new MacosBackgroundBrowserError(
        "PERSISTENT_CONTEXT_MISSING",
        "Background Chrome did not expose its persistent context",
      );
    }

    let closePromise: Promise<void> | undefined;
    return {
      browser,
      close: () => {
        closePromise ??= closeOwnedBrowser(browser, ownedProcess, dependencies);
        return closePromise;
      },
      context,
    };
  } catch (error) {
    if (!launchAttempted) throw error;

    if (!ownedProcess.port) {
      const latestPort = await readFreshPort(
        portFile,
        previousPortFile,
        dependencies,
      );
      if (latestPort) ownedProcess.port = latestPort;
    }

    try {
      await closeOwnedBrowser(browser, ownedProcess, dependencies);
    } catch (cleanupError) {
      throw new MacosBackgroundBrowserError(
        "CLEANUP_UNCONFIRMED",
        `Background Chrome startup failed and cleanup could not be confirmed: ${errorMessage(cleanupError)}`,
        { cause: error },
      );
    }
    throw error;
  }
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

async function closeOwnedBrowser(
  browser: Browser | undefined,
  ownedProcess: OwnedBrowserProcess,
  dependencies: MacosBackgroundBrowserDependencies,
): Promise<void> {
  let controlBrowser = browser;
  let controlError: unknown;

  if (!controlBrowser && ownedProcess.port) {
    try {
      controlBrowser = await dependencies.connectOverCDP(
        `http://127.0.0.1:${ownedProcess.port}`,
        dependencies.startupTimeoutMs,
      );
    } catch (error) {
      controlError = error;
    }
  }

  if (controlBrowser) {
    try {
      await closeMacosBackgroundBrowser(controlBrowser);
    } catch (error) {
      controlError = error;
    }
  }

  let remaining = await waitForOwnedProcessesToExit(ownedProcess, dependencies);
  if (remaining.length > 0) {
    await signalProcesses(remaining, "SIGTERM", dependencies);
    remaining = await waitForOwnedProcessesToExit(ownedProcess, dependencies);
  }
  if (remaining.length > 0) {
    await signalProcesses(remaining, "SIGKILL", dependencies);
    remaining = await waitForOwnedProcessesToExit(ownedProcess, dependencies);
  }

  if (remaining.length > 0) {
    throw new Error(`Chrome processes did not exit: ${remaining.join(", ")}`, {
      cause: controlError,
    });
  }
  if (controlError && !ownedProcess.confirmed) {
    throw new Error(
      `CDP cleanup failed before browser process ownership could be confirmed: ${errorMessage(controlError)}`,
      { cause: controlError },
    );
  }
}

async function waitForOwnedProcessesToExit(
  ownedProcess: OwnedBrowserProcess,
  dependencies: MacosBackgroundBrowserDependencies,
): Promise<number[]> {
  const deadline = dependencies.now() + dependencies.shutdownTimeoutMs;
  let remaining = await findOwnedProcessIds(ownedProcess, dependencies);

  while (remaining.length > 0 && dependencies.now() < deadline) {
    await dependencies.sleep(dependencies.pollIntervalMs);
    remaining = await findOwnedProcessIds(ownedProcess, dependencies);
  }
  return remaining;
}

async function findOwnedProcessIds(
  ownedProcess: OwnedBrowserProcess,
  dependencies: MacosBackgroundBrowserDependencies,
): Promise<number[]> {
  const tokenArgument = `--read-page-launch-token=${ownedProcess.launchToken}`;
  const processes = await dependencies.listProcesses();
  const tokenProcesses = findBrowserProcessesWithArgument(
    processes,
    tokenArgument,
    ownedProcess.executableName,
  ).map((process) => process.pid);
  const profileProcesses = findBrowserProcessesWithArgument(
    processes,
    ownedProcess.profileArgument,
    ownedProcess.executableName,
  ).map((process) => process.pid);
  const listeningProcesses = ownedProcess.port
    ? await dependencies.findListeningProcessIds(ownedProcess.port)
    : [];
  const candidates = [
    ...new Set([...tokenProcesses, ...profileProcesses, ...listeningProcesses]),
  ].filter((pid) => !ownedProcess.baselineProcessIds.has(pid));
  const running = candidates.filter((pid) =>
    dependencies.isProcessRunning(pid),
  );
  if (running.length > 0) ownedProcess.confirmed = true;
  return running;
}

async function signalProcesses(
  processIds: number[],
  signal: NodeJS.Signals,
  dependencies: MacosBackgroundBrowserDependencies,
): Promise<void> {
  await Promise.all(
    processIds.map((pid) =>
      dependencies.signalProcess(pid, signal).catch((error) => {
        if (isMissingProcessError(error)) return;
        throw error;
      }),
    ),
  );
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

function resolveApp(
  channel: string,
  executablePath: string | undefined,
): { executableName: string; openArguments: string[] } {
  if (executablePath) {
    const appBundle = executablePath.match(/^(.+?\.app)(?:\/.*)?$/i)?.[1];
    if (!appBundle) {
      throw new Error(
        "READ_PAGE_CHROME_PATH must point inside a macOS .app bundle when background launch is enabled. Set READ_PAGE_MACOS_BACKGROUND=0 to use Playwright's direct launcher.",
      );
    }
    return {
      executableName: basename(appBundle, ".app"),
      openArguments: [appBundle],
    };
  }

  const appName = CHANNEL_APP_NAMES[channel] || channel;
  return { executableName: appName, openArguments: ["-a", appName] };
}

async function waitForDevToolsPort(
  portFile: string,
  previous: DevToolsPortSnapshot | undefined,
  dependencies: MacosBackgroundBrowserDependencies,
): Promise<number> {
  const deadline = dependencies.now() + dependencies.startupTimeoutMs;

  while (dependencies.now() < deadline) {
    const port = await readFreshPort(portFile, previous, dependencies);
    if (port) return port;
    await dependencies.sleep(dependencies.pollIntervalMs);
  }

  throw new MacosBackgroundBrowserError(
    "STARTUP_TIMEOUT",
    `Background Chrome did not expose a DevTools port within ${dependencies.startupTimeoutMs}ms`,
  );
}

async function readFreshPort(
  portFile: string,
  previous: DevToolsPortSnapshot | undefined,
  dependencies: MacosBackgroundBrowserDependencies,
): Promise<number | undefined> {
  const current = await dependencies.readPortSnapshot(portFile);
  if (
    !current ||
    (previous &&
      current.content === previous.content &&
      current.modifiedAt === previous.modifiedAt)
  ) {
    return undefined;
  }

  const port = Number.parseInt(current.content.split(/\r?\n/, 1)[0] || "", 10);
  if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
  return undefined;
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

async function listProcesses(): Promise<BrowserProcess[]> {
  const options = { encoding: "utf8" as const, maxBuffer: 4 * 1024 * 1024 };
  const [commandsResult, executablesResult] = await Promise.all([
    execFileAsync("/bin/ps", ["-ww", "-axo", "pid=,command="], options),
    execFileAsync("/bin/ps", ["-ww", "-axo", "pid=,comm="], options),
  ]);
  const commands = parseProcessColumn(String(commandsResult.stdout));
  const executables = parseProcessColumn(String(executablesResult.stdout));

  return [...commands.entries()]
    .map(([pid, command]) => ({
      command,
      executable: executables.get(pid) || "",
      pid,
    }))
    .filter((process) => process.executable.length > 0);
}

async function findListeningProcessIds(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    return String(stdout)
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function parseProcessColumn(output: string): Map<number, string> {
  return new Map(
    output
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(\d+)\s+(.+)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [Number.parseInt(match[1] || "", 10), match[2] || ""]),
  );
}

function findBrowserProcessesWithArgument(
  processes: BrowserProcess[],
  argument: string,
  executableName: string,
): BrowserProcess[] {
  return findBrowserProcesses(processes, executableName).filter((process) =>
    process.command.includes(argument),
  );
}

function findBrowserProcesses(
  processes: BrowserProcess[],
  executableName: string,
): BrowserProcess[] {
  const expectedExecutable = executableName.toLowerCase();
  return processes.filter(
    (process) =>
      basename(process.executable).toLowerCase() === expectedExecutable,
  );
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
