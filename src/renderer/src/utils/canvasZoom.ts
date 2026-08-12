export function nextCanvasZoomFromWheel(
  currentZoom: number,
  deltaY: number,
  minimumZoom: number,
  maximumZoom: number,
  zoomStep: number,
) {
  const current = Number.isFinite(currentZoom) ? currentZoom : minimumZoom;
  const clampedCurrent = Math.max(minimumZoom, Math.min(maximumZoom, current));
  if (!Number.isFinite(deltaY) || deltaY === 0) return clampedCurrent;
  const direction = deltaY < 0 ? 1 : -1;
  return Math.max(
    minimumZoom,
    Math.min(maximumZoom, clampedCurrent + direction * zoomStep),
  );
}

export function canvasViewportGeometry(
  width: number,
  height: number,
  zoomPercent: number,
) {
  const surfaceWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const surfaceHeight = Math.max(1, Number.isFinite(height) ? height : 1);
  const scale = Math.max(
    0.25,
    (Number.isFinite(zoomPercent) ? zoomPercent : 100) / 100,
  );

  return {
    scale,
    surfaceWidth,
    surfaceHeight,
    displayedWidth: surfaceWidth * scale,
    displayedHeight: surfaceHeight * scale,
  };
}
