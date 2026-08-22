export type AuditOverlayMode = "off" | "hover" | "click" | "all";

const MODE_SEQUENCE: AuditOverlayMode[] = ["off", "hover", "click", "all"];

export function nextAuditOverlayMode(mode: AuditOverlayMode): AuditOverlayMode {
  const index = MODE_SEQUENCE.indexOf(mode);
  return MODE_SEQUENCE[(index + 1) % MODE_SEQUENCE.length];
}
export function auditOverlayModeLabel(mode: AuditOverlayMode): string {
  if (mode === "hover") return "Hover";
  if (mode === "click") return "Click";
  if (mode === "all") return "All";
  return "Off";
}
