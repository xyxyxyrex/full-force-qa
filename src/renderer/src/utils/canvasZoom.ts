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
