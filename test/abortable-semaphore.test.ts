import { describe, expect, it } from "vitest";
import { AbortableSemaphore } from "../src/concurrency/abortable-semaphore";

describe("AbortableSemaphore", () => {
  it("grants queued permits in FIFO order", async () => {
    const semaphore = new AbortableSemaphore(1);
    const first = await semaphore.acquire(undefined, "aborted");
    const acquisitionOrder: string[] = [];
    const secondPromise = semaphore
      .acquire(undefined, "aborted")
      .then((permit) => {
        acquisitionOrder.push("second");
        return permit;
      });
    const thirdPromise = semaphore
      .acquire(undefined, "aborted")
      .then((permit) => {
        acquisitionOrder.push("third");
        return permit;
      });

    first.release();
    const second = await secondPromise;
    expect(acquisitionOrder).toEqual(["second"]);

    second.release();
    const third = await thirdPromise;
    expect(acquisitionOrder).toEqual(["second", "third"]);

    third.release();
    expect(semaphore.isIdle).toBe(true);
  });

  it("removes an aborted waiter without leaking its permit", async () => {
    const semaphore = new AbortableSemaphore(1);
    const first = await semaphore.acquire(undefined, "aborted");
    const controller = new AbortController();
    const aborted = semaphore.acquire(
      controller.signal,
      "queued operation aborted",
    );
    void aborted.catch(() => undefined);
    const surviving = semaphore.acquire(undefined, "aborted");

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    first.release();
    const next = await surviving;
    expect(semaphore.isIdle).toBe(false);

    next.release();
    next.release();
    expect(semaphore.isIdle).toBe(true);
  });
});
