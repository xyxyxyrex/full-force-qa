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

export interface CanvasFrameSize {
  width: number;
  height: number;
}

export function canvasFrameStripGeometry(
  frames: CanvasFrameSize[],
  zoomPercent: number,
  gap = 48,
) {
  const scale = Math.max(
    0.25,
    (Number.isFinite(zoomPercent) ? zoomPercent : 100) / 100,
  );
  const safeGap = Math.max(0, Number.isFinite(gap) ? gap : 0);
  const displayedFrames = frames.map((frame) => ({
    width: Math.max(1, Number.isFinite(frame.width) ? frame.width : 1) * scale,
    height: Math.max(1, Number.isFinite(frame.height) ? frame.height : 1) * scale,
  }));

  return {
    scale,
    displayedWidth:
      displayedFrames.reduce((total, frame) => total + frame.width, 0) +
      Math.max(0, displayedFrames.length - 1) * safeGap,
    displayedHeight: displayedFrames.reduce(
      (maximum, frame) => Math.max(maximum, frame.height),
      0,
    ),
  };
}
