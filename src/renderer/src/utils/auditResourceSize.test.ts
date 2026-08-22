import { describe, expect, it } from "vitest";
import { dataUrlByteLength, formatAuditResourceSize } from "./auditResourceSize";

describe("Audit resource sizes", () => {
  it("formats byte sizes for compact canvas badges", () => {
    expect(formatAuditResourceSize(512)).toBe("512 B");
    expect(formatAuditResourceSize(1536)).toBe("1.50 KB");
    expect(formatAuditResourceSize(5 * 1024 * 1024)).toBe("5.00 MB");
  });

  it("measures base64 and URL-encoded data resources", () => {
    expect(dataUrlByteLength("data:text/plain;base64,SGVsbG8=" )).toBe(5);
    expect(dataUrlByteLength("data:text/plain,Hello%20world")).toBe(11);
    expect(dataUrlByteLength("https://example.com/image.png")).toBeNull();
  });
});
