import { describe, expect, it } from "vitest";
import { normalizeClassNames } from "./editBetaClasses";

describe("normalizeClassNames", () => {
  it("normalizes whitespace and removes duplicate class names", () => {
    expect(normalizeClassNames("  card\n active   card  ")).toBe("card active");
  });

  it("supports clearing the class attribute", () => {
    expect(normalizeClassNames("   ")).toBe("");
  });
});
