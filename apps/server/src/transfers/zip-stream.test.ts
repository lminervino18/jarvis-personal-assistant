import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { uniqueNames, zipSize, zipStream } from "./zip-stream.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Reads a stored ZIP back through its central directory, checking every CRC. */
function readZip(zip: Buffer): { name: string; data: string }[] {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: { name: string; data: string }[] = [];
  for (let index = 0; index < count; index++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const local = offset + 30 + zip.readUInt16LE(offset + 26);
    const data = zip.subarray(local, local + size);
    expect(crc32(data)).toBe(crc);
    files.push({ name, data: data.toString("utf8") });
    at += 46 + nameLength;
  }
  return files;
}

describe("ZIP downloads", () => {
  it("stores the files byte for byte under their original names, with an exact size known beforehand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-zip-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a"), "primer archivo");
    writeFileSync(join(dir, "b"), "segundo, más largo ".repeat(1000));
    const entries = [
      { name: "Gol de Messi.mp4", path: join(dir, "a"), size: 14 },
      { name: "Cumpleaños de Juli.jpg", path: join(dir, "b"), size: Buffer.byteLength("segundo, más largo ".repeat(1000)) },
    ];
    const zip = await buffer(zipStream(entries));
    expect(zip.length).toBe(zipSize(entries));
    expect(readZip(zip)).toEqual([
      { name: "Gol de Messi.mp4", data: "primer archivo" },
      { name: "Cumpleaños de Juli.jpg", data: "segundo, más largo ".repeat(1000) },
    ]);
  });

  it("numbers repeated names instead of overwriting them", () => {
    expect(uniqueNames(["foto.jpg", "Foto.jpg", "video.mp4", "foto.jpg"])).toEqual(["foto.jpg", "Foto (2).jpg", "video.mp4", "foto (3).jpg"]);
  });
});
