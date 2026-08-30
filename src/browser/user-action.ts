import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Page } from "playwright-core";
import type { HandoffReason } from "../types";

type HandoffWaiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const handoffWaiters: HandoffWaiter[] = [];
let handoffLocked = false;

export async function waitForUserAction(
  ctx: ExtensionContext,
  page: Page,
  url: string,
  reason: HandoffReason,
  message: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ctx.hasUI) {
    throw new Error(
      `No interactive UI available for required user action: ${reason}`,
    );
  }

  const releaseHandoff = await acquireHandoff(signal);
  const statusKey = "read-page";
  try {
    await page.bringToFront();
    ctx.ui.setStatus(statusKey, "Waiting for browser action");
    ctx.ui.setWidget(statusKey, [
      "read-page needs user action.",
      `Reason: ${reason}`,
      `URL: ${url}`,
      "Finish the action in the opened browser, then confirm here.",
    ]);

    return await ctx.ui.confirm(
      "read-page needs user action",
      [
        message,
        "",
        `URL: ${url}`,
        "",
        "Complete login / captcha / manual navigation in the opened browser.",
        "When the page is ready, return here and confirm.",
      ].join("\n"),
      { signal, timeout: 15 * 60 * 1000 },
    );
  } finally {
    ctx.ui.setStatus(statusKey, undefined);
    ctx.ui.setWidget(statusKey, []);
    releaseHandoff();
  }
}

async function acquireHandoff(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) {
    throw abortError("read-page aborted while waiting for browser handoff");
  }
  if (!handoffLocked) {
    handoffLocked = true;
    return createHandoffRelease();
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter: HandoffWaiter = { resolve, reject, signal };
    if (signal) {
      waiter.onAbort = () => {
        const index = handoffWaiters.indexOf(waiter);
        if (index >= 0) handoffWaiters.splice(index, 1);
        reject(
          abortError("read-page aborted while waiting for browser handoff"),
        );
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    handoffWaiters.push(waiter);
    if (signal?.aborted) waiter.onAbort?.();
  });
}

function createHandoffRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;

    let next: HandoffWaiter | undefined;
    while (handoffWaiters.length > 0 && !next) {
      const candidate = handoffWaiters.shift();
      if (!candidate) break;
      if (candidate.signal?.aborted) {
        candidate.onAbort?.();
        continue;
      }
      next = candidate;
    }

    if (!next) {
      handoffLocked = false;
      return;
    }
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    next.resolve(createHandoffRelease());
  };
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
