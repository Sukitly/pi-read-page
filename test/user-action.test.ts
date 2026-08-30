import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { waitForUserAction } from "../src/browser/user-action";

function createPage() {
  return {
    bringToFront: vi.fn(async () => undefined),
  } as unknown as Page;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForExpectation(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

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
    const page = createPage();

    await waitForUserAction(
      ctx,
      page,
      "https://example.com/login",
      "login_required",
      "Login required",
    );

    expect(page.bringToFront).toHaveBeenCalledTimes(1);
    expect(statusCalls).toEqual([
      { key: "read-page", text: "Waiting for browser action" },
      { key: "read-page", text: undefined },
    ]);
    expect(widgetCalls.at(-1)).toEqual({ key: "read-page", content: [] });
  });

  it("removes an aborted queued handoff and grants the next waiter", async () => {
    const firstConfirmation = deferred<boolean>();
    const firstPage = createPage();
    const abortedPage = createPage();
    const thirdPage = createPage();
    const firstContext = {
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        confirm: vi.fn(() => firstConfirmation.promise),
      },
    } as unknown as ExtensionContext;
    const immediateContext = {
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        confirm: vi.fn(async () => true),
      },
    } as unknown as ExtensionContext;
    const controller = new AbortController();

    const first = waitForUserAction(
      firstContext,
      firstPage,
      "https://example.com/first",
      "login_required",
      "First login",
    );
    await waitForExpectation(() =>
      expect(firstPage.bringToFront).toHaveBeenCalledTimes(1),
    );
    const aborted = waitForUserAction(
      immediateContext,
      abortedPage,
      "https://example.com/aborted",
      "login_required",
      "Aborted login",
      controller.signal,
    );
    void aborted.catch(() => undefined);
    const third = waitForUserAction(
      immediateContext,
      thirdPage,
      "https://example.com/third",
      "login_required",
      "Third login",
    );

    controller.abort();
    await expect(aborted).rejects.toThrow(/waiting for browser handoff/);
    expect(abortedPage.bringToFront).not.toHaveBeenCalled();
    expect(thirdPage.bringToFront).not.toHaveBeenCalled();

    firstConfirmation.resolve(true);
    await expect(first).resolves.toBe(true);
    await expect(third).resolves.toBe(true);
    expect(thirdPage.bringToFront).toHaveBeenCalledTimes(1);
  });

  it("serializes simultaneous browser handoffs", async () => {
    const firstConfirmation = deferred<boolean>();
    const firstPage = createPage();
    const secondPage = createPage();
    const firstContext = {
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        confirm: vi.fn(() => firstConfirmation.promise),
      },
    } as unknown as ExtensionContext;
    const secondContext = {
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        confirm: vi.fn(async () => true),
      },
    } as unknown as ExtensionContext;

    const first = waitForUserAction(
      firstContext,
      firstPage,
      "https://example.com/first",
      "login_required",
      "First login",
    );
    await waitForExpectation(() =>
      expect(firstPage.bringToFront).toHaveBeenCalledTimes(1),
    );
    const second = waitForUserAction(
      secondContext,
      secondPage,
      "https://example.com/second",
      "login_required",
      "Second login",
    );

    await Promise.resolve();
    expect(secondPage.bringToFront).not.toHaveBeenCalled();

    firstConfirmation.resolve(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(secondPage.bringToFront).toHaveBeenCalledTimes(1);
  });
});
