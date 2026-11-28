import { createReadStream } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";

export interface ZipEntry {
  name: string;
  path: string;
  size: number;
}

/** Without ZIP64, no file and no offset may pass 4 GB. */
export const MAX_ZIP_BYTES = 0xffff_fffe;

const LOCAL = 30;
const DESCRIPTOR = 16;
const CENTRAL = 46;
const END = 22;

/** Names inside the archive: the originals, with « (2)», « (3)»… before the extension when two repeat. */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 1) return name;
    const ext = extname(name);
    return `${name.slice(0, name.length - ext.length)} (${count})${ext}`;
  });
}

/** The archive's exact size, known before writing it, so the download can show its progress. */
export function zipSize(entries: readonly ZipEntry[]): number {
  return entries.reduce((total, entry) => {
    const name = Buffer.byteLength(entry.name);
    return total + LOCAL + name + entry.size + DESCRIPTOR + CENTRAL + name;
  }, END);
}

function dosTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * A ZIP of the given files, stored without compression and written as it goes: each file is read
 * once, its CRC goes in a data descriptor after it, and nothing is held in memory. Names are UTF-8.
 */
export function zipStream(entries: readonly ZipEntry[], now = new Date()): Readable {
  const { time, day } = dosTime(now);
  async function* parts(): AsyncGenerator<Buffer> {
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const name = Buffer.from(entry.name);
      const header = Buffer.alloc(LOCAL);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0808, 6);
      header.writeUInt16LE(0, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(day, 12);
      header.writeUInt16LE(name.length, 26);
      yield header;
      yield name;
      let crc = 0;
      let size = 0;
      for await (const chunk of createReadStream(entry.path)) {
        const data = chunk as Buffer;
        crc = crc32(data, crc);
        size += data.length;
        yield data;
      }
      const descriptor = Buffer.alloc(DESCRIPTOR);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc >>> 0, 4);
      descriptor.writeUInt32LE(size, 8);
      descriptor.writeUInt32LE(size, 12);
      yield descriptor;
      const record = Buffer.alloc(CENTRAL);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0808, 8);
      record.writeUInt16LE(0, 10);
      record.writeUInt16LE(time, 12);
      record.writeUInt16LE(day, 14);
      record.writeUInt32LE(crc >>> 0, 16);
      record.writeUInt32LE(size, 20);
      record.writeUInt32LE(size, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(offset, 42);
      central.push(record, name);
      offset += LOCAL + name.length + size + DESCRIPTOR;
    }
    const directory = Buffer.concat(central);
    yield directory;
    const end = Buffer.alloc(END);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    yield end;
  }
  return Readable.from(parts());
}
