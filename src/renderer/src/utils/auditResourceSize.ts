export const AUDIT_MEDIA_SELECTOR = "img, video, audio, object, embed";

export function auditMediaResourceUrl(element: Element): string {
  const htmlElement = element as HTMLElement & {
    currentSrc?: string;
    src?: string;
    data?: string;
  };
  const tag = element.tagName.toLowerCase();
  let raw = "";

  if (tag === "object") raw = htmlElement.data || element.getAttribute("data") || "";
  else if (tag === "video" || tag === "audio") {
    raw =
      htmlElement.currentSrc ||
      htmlElement.src ||
      element.getAttribute("src") ||
      element.querySelector("source[src]")?.getAttribute("src") ||
      "";
  } else {
    raw = htmlElement.currentSrc || htmlElement.src || element.getAttribute("src") || "";
  }

  if (!raw) return "";
  try {
    return new URL(raw, element.ownerDocument.baseURI).href;
  } catch {
    return raw;
  }
}

export function dataUrlByteLength(url: string): number | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const metadata = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  try {
    if (/;base64(?:;|$)/i.test(metadata)) {
      const cleaned = payload.replace(/\s/g, "");
      const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
      return Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
    }
    return new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
  } catch {
    return null;
  }
}

export function formatAuditResourceSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function auditMediaTypeLabel(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "img") return "IMG";
  if (tag === "video") return "VIDEO";
  if (tag === "audio") return "AUDIO";
  if (tag === "object") return "OBJECT";
  return "EMBED";
}
