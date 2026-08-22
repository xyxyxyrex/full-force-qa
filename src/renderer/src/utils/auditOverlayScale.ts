export interface AuditOverlayGeometry {
  inverseScale: number;
  stackStep: number;
  underlineThickness: number;
}
export function auditOverlayGeometry(canvasZoom: number): AuditOverlayGeometry {
  const normalizedZoom =
    Number.isFinite(canvasZoom) && canvasZoom > 0 ? canvasZoom : 100;
  const inverseScale = 100 / normalizedZoom;
  return {
    inverseScale,
    stackStep: 22 * inverseScale,
    underlineThickness: 2 * inverseScale,
  };
}
