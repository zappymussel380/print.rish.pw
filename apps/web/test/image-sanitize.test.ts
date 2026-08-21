import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ImageRejected, sanitizeImage } from "@/lib/image-sanitize";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name));

/** A real JPEG whose APP1 segment carries a GPS IFD (26deg 11' N) and whose COM
 *  segment names the camera — exactly what a phone photo of a print looks like. */
const jpeg = () => fixture("photo-with-exif.jpg");
/** A real PNG carrying tEXt chunks, including a written-out GPS position. */
const png = () => fixture("photo-with-text.png");

describe("sanitizeImage", () => {
  it("strips the GPS block out of a JPEG", () => {
    const input = jpeg();
    // The fixture really does carry the location, or this test proves nothing.
    expect(input.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(true);

    const { kind, bytes } = sanitizeImage(input);

    expect(kind).toBe("jpg");
    expect(bytes.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(false);
    expect(bytes.includes(Buffer.from("workshop camera"))).toBe(false);
    expect(bytes.length).toBeLessThan(input.length);
  });

  it("leaves the JPEG a structurally valid JPEG", () => {
    const { bytes } = sanitizeImage(jpeg());

    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    // The frame header, Huffman tables and scan must all survive; dropping any
    // of them would leave an undecodable file.
    for (const marker of [0xc0, 0xc4, 0xdb, 0xda]) {
      expect(bytes.includes(Buffer.from([0xff, marker]))).toBe(true);
    }
  });

  it("strips text chunks out of a PNG while keeping the image data", () => {
    const input = png();
    expect(input.includes(Buffer.from("tEXt"))).toBe(true);

    const { kind, bytes } = sanitizeImage(input);

    expect(kind).toBe("png");
    expect(bytes.includes(Buffer.from("tEXt"))).toBe(false);
    expect(bytes.includes(Buffer.from("GPS 26.1868"))).toBe(false);
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    for (const chunk of ["IHDR", "IDAT", "IEND"]) {
      expect(bytes.includes(Buffer.from(chunk))).toBe(true);
    }
  });

  it("is idempotent — a sanitized image passes through unchanged", () => {
    const once = sanitizeImage(jpeg()).bytes;
    expect(sanitizeImage(once).bytes).toEqual(once);
    const pngOnce = sanitizeImage(png()).bytes;
    expect(sanitizeImage(pngOnce).bytes).toEqual(pngOnce);
  });

  it("refuses anything that is not really a JPEG or PNG", () => {
    expect(() => sanitizeImage(Buffer.from("<svg onload=alert(1)>"))).toThrow(ImageRejected);
    expect(() => sanitizeImage(Buffer.from("GIF89a"))).toThrow(ImageRejected);
    expect(() => sanitizeImage(Buffer.alloc(0))).toThrow(ImageRejected);
  });

  it("rejects a truncated file rather than emitting half an image", () => {
    expect(() => sanitizeImage(jpeg().subarray(0, 40))).toThrow(ImageRejected);
    expect(() => sanitizeImage(png().subarray(0, 40))).toThrow(ImageRejected);
  });

  it("rejects a PNG whose chunk length runs past the end of the file", () => {
    const input = png();
    const forged = Buffer.from(input);
    // Overstate the IHDR length: a parser that trusted it would read out of
    // bounds or copy attacker-chosen bytes into the served file.
    forged.writeUInt32BE(0x7ffffff0, 8);
    expect(() => sanitizeImage(forged)).toThrow(ImageRejected);
  });
});
