import { describe, expect, it } from "vitest";
import { isMouseButtonHeld, mouseButtonMask } from "./canvasPan";

describe("canvas pan mouse buttons", () => {
  it("maps DOM button values to the MouseEvent.buttons bitmask", () => {
    expect(mouseButtonMask(0)).toBe(1);
    expect(mouseButtonMask(1)).toBe(4);
    expect(mouseButtonMask(2)).toBe(2);
    expect(mouseButtonMask(3)).toBe(0);
  });

  it("detects when the button that started a pan is no longer held", () => {
    expect(isMouseButtonHeld(4, mouseButtonMask(1))).toBe(true);
    expect(isMouseButtonHeld(5, mouseButtonMask(1))).toBe(true);
    expect(isMouseButtonHeld(0, mouseButtonMask(1))).toBe(false);
    expect(isMouseButtonHeld(1, mouseButtonMask(1))).toBe(false);
  });
});
