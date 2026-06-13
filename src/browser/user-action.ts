import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HandoffReason } from "../types";

export async function waitForUserAction(
  ctx: ExtensionContext,
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

  const statusKey = "read-page";
  ctx.ui.setStatus(statusKey, "Waiting for browser action");
  ctx.ui.setWidget(statusKey, [
    "read-page needs user action.",
    `Reason: ${reason}`,
    `URL: ${url}`,
    "Finish the action in the opened browser, then confirm here.",
  ]);

  try {
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
    ctx.ui.setStatus(statusKey, "");
    ctx.ui.setWidget(statusKey, []);
  }
}
