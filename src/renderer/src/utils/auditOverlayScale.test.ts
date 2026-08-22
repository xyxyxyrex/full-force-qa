import { describe, expect, it } from "vitest";
import { auditOverlayGeometry } from "./auditOverlayScale";

describe("auditOverlayGeometry", () => {
  it.each([
    [25, 4],
    [50, 2],
    [100, 1],
    [200, 0.5],
  ])("counter-scales a %s%% canvas", (zoom, inverseScale) => {
    expect(auditOverlayGeometry(zoom)).toEqual({
      inverseScale,
      stackStep: 22 * inverseScale,
      underlineThickness: 2 * inverseScale,
    });
  });

  it("falls back to the unscaled geometry for invalid zoom", () => {
    expect(auditOverlayGeometry(0).inverseScale).toBe(1);
    expect(auditOverlayGeometry(Number.NaN).inverseScale).toBe(1);
  });
});
