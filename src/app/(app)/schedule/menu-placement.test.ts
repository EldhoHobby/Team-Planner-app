import { describe, expect, it } from "vitest";
import { subPlacementFor } from "./menu-placement";

describe("job actions menu — Reassign to placement", () => {
  it("flies out to the right on a wide screen", () => {
    expect(subPlacementFor(100, 1440)).toBe("right");
  });

  it("flips to the left near the right edge of a wide screen", () => {
    // The menu is clamped to innerWidth − 220, so near the edge there is no room on the right.
    expect(subPlacementFor(1440 - 220, 1440)).toBe("left");
  });

  it("opens inline on a phone (no room on either side)", () => {
    // 375 px wide: the menu is clamped to at most 155 px from the left.
    for (const left of [4, 80, 155]) expect(subPlacementFor(left, 375)).toBe("inline");
  });
});
