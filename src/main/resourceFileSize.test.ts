import { describe, expect, it } from "vitest";
import { measureResponseBody, resourceSizeFromHeaders } from "./resourceFileSize";

describe("resource file-size resolution", () => {
  it("reads the complete length returned by HEAD or a normal GET", () => {
    const response = new Response(null, {
      status: 200,
      headers: { "content-length": "645398" },
    });
    expect(resourceSizeFromHeaders(response)).toBe(645398);
  });

  it("prefers the total from Content-Range over the partial response length", () => {
    const response = new Response(new Uint8Array([1]), {
      status: 206,
      headers: {
        "content-length": "1",
        "content-range": "bytes 0-0/645398",
      },
    });
    expect(resourceSizeFromHeaders(response)).toBe(645398);
  });

  it("does not report a partial range as the complete file size", () => {
    const response = new Response(new Uint8Array([1]), {
      status: 206,
      headers: { "content-length": "1" },
    });
    expect(resourceSizeFromHeaders(response)).toBeNull();
  });

  it("counts a complete streamed response when the server omits length headers", async () => {
    const response = new Response(new Uint8Array(4097), { status: 200 });
    expect(await measureResponseBody(response)).toBe(4097);
  });

  it("stops counting responses above the safety limit", async () => {
    const response = new Response(new Uint8Array(32), { status: 200 });
    expect(await measureResponseBody(response, 16)).toBeNull();
  });
});
