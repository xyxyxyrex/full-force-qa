import { describe, expect, it } from "vitest";
import {
  layoutModeFromDisplay,
  mergeViewportPatches,
  normalizeBoxModelValue,
} from "./viewportLayoutPatches";

describe("layoutModeFromDisplay", () => {
  it.each([
    ["flex", "flex"],
    ["inline-flex", "flex"],
    ["grid", "grid"],
    ["inline-grid", "grid"],
    ["block", "block"],
  ] as const)("detects %s as %s", (display, expected) => {
    expect(layoutModeFromDisplay(display)).toBe(expected);
  });
});

describe("normalizeBoxModelValue", () => {
  it("preserves the computed unit when a user enters only a number", () => {
    expect(normalizeBoxModelValue("12", "4rem")).toBe("12rem");
    expect(normalizeBoxModelValue("-8.5", "0px")).toBe("-8.5px");
  });

  it("accepts CSS values and ignores an empty draft", () => {
    expect(normalizeBoxModelValue("calc(100% - 20px)", "10px")).toBe(
      "calc(100% - 20px)",
    );
    expect(normalizeBoxModelValue("", "10px")).toBe("10px");
  });
});

describe("mergeViewportPatches", () => {
  it("keeps active and shared patches while preserving other viewport edits", () => {
    const existing = [
      { type: "style", property: "color", value: "red" },
      { type: "style", property: "display", value: "grid", viewportId: "mobile" },
      { type: "style", property: "display", value: "flex", viewportId: "desktop" },
    ];
    const active = [
      { type: "style", property: "color", value: "blue" },
      { type: "style", property: "gap", value: "16px", viewportId: "desktop" },
    ];

    expect(mergeViewportPatches(existing, active, "desktop")).toEqual([
      active[0],
      active[1],
      existing[1],
    ]);
  });

  it("appends new active patches without reordering existing recording history", () => {
    const shared = { type: "style", property: "color", value: "red" };
    const mobile = {
      type: "style",
      property: "display",
      value: "grid",
      viewportId: "mobile",
    };
    const desktop = {
      type: "style",
      property: "display",
      value: "flex",
      viewportId: "desktop",
    };
    const gap = {
      type: "style",
      property: "gap",
      value: "16px",
      viewportId: "desktop",
    };

    expect(
      mergeViewportPatches(
        [shared, mobile, desktop],
        [shared, desktop, gap],
        "desktop",
      ),
    ).toEqual([shared, mobile, desktop, gap]);
  });
});
