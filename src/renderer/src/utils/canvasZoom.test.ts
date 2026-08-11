import { describe, expect, it } from "vitest";
import { nextCanvasZoomFromWheel } from "./canvasZoom";

describe("nextCanvasZoomFromWheel", () => {
  it("zooms in for an upward Ctrl+wheel gesture", () => {
    expect(nextCanvasZoomFromWheel(100, -120, 25, 200, 10)).toBe(110);
  });

  it("zooms out for a downward Ctrl+wheel gesture", () => {
    expect(nextCanvasZoomFromWheel(100, 120, 25, 200, 10)).toBe(90);
  });

  it("clamps repeated gestures to the canvas zoom limits", () => {
    expect(nextCanvasZoomFromWheel(200, -120, 25, 200, 10)).toBe(200);
    expect(nextCanvasZoomFromWheel(25, 120, 25, 200, 10)).toBe(25);
  });

  it("ignores empty or invalid wheel deltas", () => {
    expect(nextCanvasZoomFromWheel(75, 0, 25, 200, 10)).toBe(75);
    expect(nextCanvasZoomFromWheel(75, Number.NaN, 25, 200, 10)).toBe(75);
  });
});
