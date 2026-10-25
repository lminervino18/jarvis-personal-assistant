import qrcode from "qrcode-generator";

/** Encodes `text` into a QR matrix locally; nothing leaves the device. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => qr.isDark(row, column)));
}

const QUIET_ZONE = 4;

/** SVG path covering every dark module, offset by the quiet zone. */
export function qrPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
    }),
  );
  return parts.join("");
}

export function qrViewSize(matrix: boolean[][]): number {
  return matrix.length + QUIET_ZONE * 2;
}
