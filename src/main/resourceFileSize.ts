const DEFAULT_BODY_LIMIT = 64 * 1024 * 1024;

function positiveHeaderNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function resourceSizeFromHeaders(response: Response): number | null {
  const contentRange = response.headers.get("content-range") || "";
  const totalMatch = contentRange.match(/\/\s*(\d+)\s*$/);
  if (totalMatch) return positiveHeaderNumber(totalMatch[1]);

  // A 206 response's Content-Length is only the returned byte range, not the
  // resource's complete file size.
  if (response.status === 206) return null;
  return positiveHeaderNumber(response.headers.get("content-length"));
}

export async function measureResponseBody(
  response: Response,
  maximumBytes = DEFAULT_BODY_LIMIT,
): Promise<number | null> {
  if (!response.body || response.status === 206) return null;
  const safeLimit = Math.max(1, maximumBytes);
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return total;
      total += chunk.value.byteLength;
      if (total > safeLimit) {
        await reader.cancel();
        return null;
      }
    }
  } catch {
    try { await reader.cancel(); } catch {}
    return null;
  }
}
