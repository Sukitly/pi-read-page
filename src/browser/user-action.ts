import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Page } from "playwright-core";
import { AbortableSemaphore } from "../concurrency/abortable-semaphore";
import type { HandoffReason } from "../types";

const handoffSemaphore = new AbortableSemaphore(1);

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

  const handoffPermit = await handoffSemaphore.acquire(
    signal,
    "read-page aborted while waiting for browser handoff",
  );
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
    handoffPermit.release();
  }
}
