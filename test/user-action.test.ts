import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { waitForUserAction } from "../src/browser/user-action";

describe("user action UI cleanup", () => {
  it("clears footer status with undefined instead of an empty string", async () => {
    const statusCalls: Array<{ key: string; text: string | undefined }> = [];
    const widgetCalls: Array<{ key: string; content: string[] | undefined }> =
      [];
    const ctx = {
      hasUI: true,
      ui: {
        setStatus(key: string, text: string | undefined) {
          statusCalls.push({ key, text });
        },
        setWidget(key: string, content: string[] | undefined) {
          widgetCalls.push({ key, content });
        },
        confirm: async () => true,
      },
    } as unknown as ExtensionContext;

    await waitForUserAction(
      ctx,
      "https://example.com/login",
      "login_required",
      "Login required",
    );

    expect(statusCalls).toEqual([
      { key: "read-page", text: "Waiting for browser action" },
      { key: "read-page", text: undefined },
    ]);
    expect(widgetCalls.at(-1)).toEqual({ key: "read-page", content: [] });
  });
});
