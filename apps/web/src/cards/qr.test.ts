import { describe, expect, it } from "vitest";
import { qrMatrix, qrPath, qrViewSize } from "./qr.js";

const PAYLOAD = "2@ficticio,AbCdEf123456,ZyXwVu654321,1";

describe("QR encoding", () => {
  it("builds a square matrix with the three finder patterns", () => {
    const matrix = qrMatrix(PAYLOAD);
    const size = matrix.length;
    expect(size).toBeGreaterThanOrEqual(21);
    expect(matrix.every((row) => row.length === size)).toBe(true);
    for (const [row, column] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ] as const) {
      expect(matrix[row]?.[column]).toBe(true);
      expect(matrix[row + 3]?.[column + 3]).toBe(true);
      expect(matrix[row + 1]?.[column + 1]).toBe(false);
      expect(matrix[row + 6]?.[column + 6]).toBe(true);
    }
  });

  it("is deterministic and depends on the content", () => {
    expect(qrMatrix(PAYLOAD)).toEqual(qrMatrix(PAYLOAD));
    expect(qrMatrix(PAYLOAD)).not.toEqual(qrMatrix(`${PAYLOAD}x`));
  });

  it("emits one square per dark module inside a quiet zone", () => {
    const matrix = qrMatrix(PAYLOAD);
    const dark = matrix.flat().filter(Boolean).length;
    expect(qrPath(matrix).split("M").length - 1).toBe(dark);
    expect(qrViewSize(matrix)).toBe(matrix.length + 8);
    expect(qrPath([[true]])).toBe("M4 4h1v1h-1z");
  });
});
