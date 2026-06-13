import { describe, expect, it } from "vitest";
import { paginate } from "../src/cache/cache";

describe("paginate", () => {
  it("returns selected line range and next offset", () => {
    const result = paginate("a\nb\nc\nd", 2, 2);
    expect(result).toEqual({
      selected: "b\nc",
      totalLines: 4,
      shownStart: 2,
      shownEnd: 3,
      nextOffset: 4,
      truncated: false,
      shownBytes: 3,
      totalBytes: 3,
    });
  });

  it("omits next offset at document end", () => {
    const result = paginate("a\nb", 1, 2);
    expect(result.nextOffset).toBeUndefined();
    expect(result.shownEnd).toBe(2);
  });

  it("returns an empty page when offset is beyond end", () => {
    expect(paginate("a\nb", 3, 1)).toEqual({
      selected: "",
      totalLines: 2,
      shownStart: 3,
      shownEnd: 2,
      truncated: false,
      shownBytes: 0,
      totalBytes: 0,
    });
  });

  it("corrects next offset to the last emitted line when the window is byte-truncated", () => {
    const markdown = "line1\nline2\nline3\nline4";
    // maxBytes only fits the first two lines ("line1\nline2" = 11 bytes).
    const result = paginate(markdown, 1, 4, 11);
    expect(result.selected).toBe("line1\nline2");
    expect(result.truncated).toBe(true);
    expect(result.shownEnd).toBe(2);
    expect(result.nextOffset).toBe(3);

    // Following nextOffset recovers the lines dropped by truncation.
    const next = paginate(markdown, result.nextOffset ?? 1, 4, 11);
    expect(next.selected).toBe("line3\nline4");
    expect(next.shownStart).toBe(3);
    expect(next.nextOffset).toBeUndefined();
  });

  it("advances at least one line when a single line exceeds the byte limit", () => {
    const markdown = `${"x".repeat(50)}\nshort`;
    const result = paginate(markdown, 1, 2, 10);
    expect(result.truncated).toBe(true);
    expect(result.shownEnd).toBe(1);
    expect(result.nextOffset).toBe(2);
  });
});
