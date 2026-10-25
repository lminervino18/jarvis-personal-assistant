import { useMemo } from "react";
import { qrMatrix, qrPath, qrViewSize } from "./qr.js";

export function QrCode({ value, label }: { value: string; label: string }) {
  const { path, size } = useMemo(() => {
    const matrix = qrMatrix(value);
    return { path: qrPath(matrix), size: qrViewSize(matrix) };
  }, [value]);
  return (
    <svg className="card-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
