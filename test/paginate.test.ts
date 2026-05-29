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
    });
  });
});
