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
  createMacosBackgroundBrowserLauncher,
  type DevToolsPortSnapshot,
} from "../src/browser/macos-background-browser";

function createBrowser(
  contexts: BrowserContext[] = [],
  onBrowserClose: () => void = () => undefined,
  browserCloseError?: Error,
) {
  const send = vi.fn(async (method: string) => {
    if (method === "Browser.close") {
      if (browserCloseError) throw browserCloseError;
      onBrowserClose();
    }
    return {};
  });
  const session = {
    send,
    detach: vi.fn(async () => undefined),
  } as unknown as CDPSession;
  const browser = {
    contexts: vi.fn(() => contexts),
    newBrowserCDPSession: vi.fn(async () => session),
    close: vi.fn(async () => undefined),
  } as unknown as Browser;
  return { browser, send, session };
}

function createLaunchHarness(options: {
  browserCloseError?: Error;
  contexts?: BrowserContext[];
  portSnapshots?: Array<DevToolsPortSnapshot | undefined>;
}) {
  let clock = 0;
  let launched = false;
  let running = false;
  const context = {} as BrowserContext;
  const { browser, send } = createBrowser(
    options.contexts ?? [context],
    () => {
      running = false;
    },
    options.browserCloseError,
  );
  const snapshots = [...(options.portSnapshots ?? [])];
  const readPortSnapshot = vi.fn(async () => snapshots.shift());
  const openApplication = vi.fn(async () => {
    launched = true;
    running = true;
  });
  const connectOverCDP = vi.fn(async () => browser);
  const signalProcess = vi.fn(async (_pid: number, signal: NodeJS.Signals) => {
    if (signal === "SIGTERM" || signal === "SIGKILL") running = false;
  });
  const listProcesses = vi.fn(async () =>
    launched && running
      ? [
          {
            pid: 42,
            command:
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --read-page-launch-token=launch-token",
            executable:
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          },
        ]
      : [],
  );
  const findListeningProcessIds = vi.fn(async () => (running ? [42] : []));

  const launcher = createMacosBackgroundBrowserLauncher({
    connectOverCDP,
    findListeningProcessIds,
    isProcessRunning: () => running,
    listProcesses,
    now: () => clock,
    openApplication,
    pollIntervalMs: 1,
    randomId: () => "launch-token",
    readPortSnapshot,
    shutdownTimeoutMs: 2,
    signalProcess,
    sleep: async (ms) => {
      clock += ms;
    },
    startupTimeoutMs: 3,
  });

  return {
    browser,
    connectOverCDP,
    context,
    findListeningProcessIds,
    launcher,
    listProcesses,
    openApplication,
    readPortSnapshot,
    send,
    signalProcess,
  };
}

describe("macOS background browser", () => {
  it("closes the externally launched Chrome process through CDP", async () => {
    const { browser, send } = createBrowser();

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

  it("waits for a changed port file before connecting", async () => {
    const previous = { content: "9000\nold", modifiedAt: 1 };
    const current = { content: "9222\nnew", modifiedAt: 2 };
    const harness = createLaunchHarness({
      portSnapshots: [previous, previous, current],
    });

    const launched = await harness.launcher("/tmp/profile", {
      channel: "chrome",
    });

    expect(harness.readPortSnapshot).toHaveBeenCalledTimes(3);
    expect(harness.connectOverCDP).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      3,
    );
    expect(harness.openApplication).toHaveBeenCalledWith(
      expect.arrayContaining([
        "-g",
        "-n",
        "--user-data-dir=/tmp/profile",
        "--read-page-launch-token=launch-token",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
      ]),
    );

    await launched.close();
    expect(harness.send).toHaveBeenCalledWith("Browser.close");
  });

  it("classifies a live profile owner without launching another Chrome", async () => {
    const harness = createLaunchHarness({ portSnapshots: [undefined] });
    harness.listProcesses.mockResolvedValueOnce([
      {
        pid: 12,
        command:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/profile",
        executable:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
    ]);

    await expect(
      harness.launcher("/tmp/profile", { channel: "chrome" }),
    ).rejects.toMatchObject({ code: "PROFILE_IN_USE" });
    expect(harness.openApplication).not.toHaveBeenCalled();
  });

  it("ignores non-browser processes that mention the profile argument", async () => {
    const harness = createLaunchHarness({
      portSnapshots: [undefined, { content: "9222\nnew", modifiedAt: 1 }],
    });
    harness.listProcesses.mockResolvedValueOnce([
      {
        pid: 12,
        command: "/bin/bash -c pgrep -f -- --user-data-dir=/tmp/profile",
        executable: "/bin/bash",
      },
    ]);

    const launched = await harness.launcher("/tmp/profile", {
      channel: "chrome",
    });

    expect(harness.openApplication).toHaveBeenCalledTimes(1);
    await launched.close();
  });

  it("classifies a Launch Services failure and confirms no process remains", async () => {
    const harness = createLaunchHarness({
      portSnapshots: [undefined, undefined],
    });
    harness.openApplication.mockRejectedValue(new Error("open failed"));

    await expect(
      harness.launcher("/tmp/profile", { channel: "chrome" }),
    ).rejects.toMatchObject({ code: "BACKGROUND_LAUNCH_FAILED" });

    expect(harness.connectOverCDP).not.toHaveBeenCalled();
    expect(harness.signalProcess).not.toHaveBeenCalled();
  });

  it("terminates its owned process after a startup timeout", async () => {
    const harness = createLaunchHarness({
      portSnapshots: [undefined, undefined, undefined, undefined, undefined],
    });

    await expect(
      harness.launcher("/tmp/profile", { channel: "chrome" }),
    ).rejects.toMatchObject({ code: "STARTUP_TIMEOUT" });

    expect(harness.connectOverCDP).not.toHaveBeenCalled();
    expect(harness.signalProcess).toHaveBeenCalledWith(42, "SIGTERM");
  });

  it("reconnects over CDP to clean up after the initial connection fails", async () => {
    const harness = createLaunchHarness({
      portSnapshots: [undefined, { content: "9222\nnew", modifiedAt: 1 }],
    });
    harness.connectOverCDP
      .mockRejectedValueOnce(new Error("initial CDP failure"))
      .mockResolvedValueOnce(harness.browser);

    await expect(
      harness.launcher("/tmp/profile", { channel: "chrome" }),
    ).rejects.toMatchObject({ code: "CDP_CONNECT_FAILED" });

    expect(harness.connectOverCDP).toHaveBeenCalledTimes(2);
    expect(harness.send).toHaveBeenCalledWith("Browser.close");
    expect(harness.signalProcess).not.toHaveBeenCalled();
  });

  it("closes Chrome when its persistent context is missing", async () => {
    const harness = createLaunchHarness({
      contexts: [],
      portSnapshots: [undefined, { content: "9222\nnew", modifiedAt: 1 }],
    });

    await expect(
      harness.launcher("/tmp/profile", { channel: "chrome" }),
    ).rejects.toMatchObject({ code: "PERSISTENT_CONTEXT_MISSING" });

    expect(harness.send).toHaveBeenCalledWith("Browser.close");
    expect(harness.signalProcess).not.toHaveBeenCalled();
  });

  it("uses process termination when Browser.close fails", async () => {
    const harness = createLaunchHarness({
      browserCloseError: new Error("CDP close failed"),
      portSnapshots: [undefined, { content: "9222\nnew", modifiedAt: 1 }],
    });
    const launched = await harness.launcher("/tmp/profile", {
      channel: "chrome",
    });

    await expect(launched.close()).resolves.toBeUndefined();

    expect(harness.signalProcess).toHaveBeenCalledWith(42, "SIGTERM");
  });

  it("reports cleanup as unconfirmed when CDP and process termination fail", async () => {
    const harness = createLaunchHarness({
      portSnapshots: [undefined, { content: "9222\nnew", modifiedAt: 1 }],
    });
    harness.connectOverCDP.mockRejectedValue(new Error("CDP unavailable"));
    harness.signalProcess.mockImplementation(async () => undefined);

    await expect(
      harness.launcher("/tmp/profile", { channel: "chrome" }),
    ).rejects.toMatchObject({ code: "CLEANUP_UNCONFIRMED" });

    expect(harness.signalProcess).toHaveBeenCalledWith(42, "SIGTERM");
    expect(harness.signalProcess).toHaveBeenCalledWith(42, "SIGKILL");
  });
});
