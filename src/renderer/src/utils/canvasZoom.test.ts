import { describe, expect, it } from "vitest";
import {
  canvasFrameStripGeometry,
  canvasViewportGeometry,
  nextCanvasZoomFromWheel,
} from "./canvasZoom";

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

describe("canvasViewportGeometry", () => {
  it("keeps the responsive guest surface full-size while visually zooming the canvas", () => {
    expect(canvasViewportGeometry(1920, 1200, 60)).toEqual({
      scale: 0.6,
      surfaceWidth: 1920,
      surfaceHeight: 1200,
      displayedWidth: 1152,
      displayedHeight: 720,
    });
  });

  it("expands a multi-device strip to contain every enabled frame", () => {
    expect(
      canvasFrameStripGeometry(
        [
          { width: 1920, height: 1200 },
          { width: 1180, height: 820 },
          { width: 430, height: 932 },
        ],
        50,
      ),
    ).toEqual({
      scale: 0.5,
      displayedWidth: 1861,
      displayedHeight: 600,
    });
  });

  it("auto-adjusts when frames are removed or zoom changes", () => {
    expect(
      canvasFrameStripGeometry(
        [
          { width: 1180, height: 820 },
          { width: 430, height: 932 },
        ],
        75,
      ),
    ).toEqual({
      scale: 0.75,
      displayedWidth: 1255.5,
      displayedHeight: 699,
    });
    expect(canvasFrameStripGeometry([], 75)).toEqual({
      scale: 0.75,
      displayedWidth: 0,
      displayedHeight: 0,
    });
  });
});
