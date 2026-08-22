export interface ViewportPatch {
  viewportId?: string;
  [key: string]: unknown;
}

export function layoutModeFromDisplay(
  display: string,
): "block" | "flex" | "grid" {
  if (display.includes("flex")) return "flex";
  if (display.includes("grid")) return "grid";
  return "block";
}

export function normalizeBoxModelValue(rawValue: string, originalValue: string) {
  const raw = rawValue.trim();
  if (!raw) return originalValue;
  if (!/^-?\d*\.?\d+$/.test(raw)) return raw;
  const originalUnit = originalValue.trim().match(/(?:^-?\d*\.?\d+)\s*([a-z%]+)$/i)?.[1];
  return `${raw}${originalUnit || "px"}`;
}

export function mergeViewportPatches<T extends ViewportPatch>(
  existing: T[],
  activePatches: T[],
  activeViewportId: string,
): T[] {
  const existingForActiveViewport = existing.filter(
    (patch) => !patch.viewportId || patch.viewportId === activeViewportId,
  );
  const samePatch = (left: T, right: T) =>
    JSON.stringify(left) === JSON.stringify(right);
  const activeHistoryIsAnAppend = existingForActiveViewport.every(
    (patch, index) => samePatch(patch, activePatches[index]),
  );
  if (activeHistoryIsAnAppend) {
    return [
      ...existing,
      ...activePatches.slice(existingForActiveViewport.length),
    ];
  }

  const patchesFromOtherViewports = existing.filter(
    (patch) => patch.viewportId && patch.viewportId !== activeViewportId,
  );
  return [...activePatches, ...patchesFromOtherViewports];
}
