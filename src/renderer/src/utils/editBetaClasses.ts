export function normalizeClassNames(value: string): string {
  return Array.from(
    new Set(
      String(value || "")
        .split(/\s+/)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ).join(" ");
}
