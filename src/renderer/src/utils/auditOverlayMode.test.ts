import { describe, expect, it } from "vitest";
import {
  auditOverlayModeLabel,
  nextAuditOverlayMode,
  type AuditOverlayMode,
} from "./auditOverlayMode";

describe("Audit overlay modes", () => {
  it("cycles off, hover, click, all, and back to off", () => {
    const modes: AuditOverlayMode[] = ["off"];
    for (let index = 0; index < 4; index += 1) {
      modes.push(nextAuditOverlayMode(modes[modes.length - 1]));
    }
    expect(modes).toEqual(["off", "hover", "click", "all", "off"]);
  });

  it.each([
    ["off", "Off"],
    ["hover", "Hover"],
    ["click", "Click"],
    ["all", "All"],
  ] as const)("labels %s mode", (mode, label) => {
    expect(auditOverlayModeLabel(mode)).toBe(label);
  });
});
