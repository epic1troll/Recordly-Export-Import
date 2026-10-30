/**
 * Minimal, dependency-free ZIP support for project bundles.
 *
 * Writer: streams files into an archive as "stored" entries (video/audio is already
 *         compressed), supports Zip64 so a bundle can exceed 4 GB.
 * Reader: reads the central directory and extracts stored or deflated entries by
 *         streaming, verifying size and CRC-32. Encrypted entries are rejected.
 *
 * Only Node built-ins are used, so no new runtime dependency has to be packaged.
 */

import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

const MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_ENTRY_BYTES = 64 * 1024 * 1024;
const IO_CHUNK_BYTES = 1024 * 1024;

// ── CRC-32 ───────────────────────────────────────────────────────────────────

let crcTable: Uint32Array | null = null;

function fallbackCrc32(data: Uint8Array, previous: number): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) {
				c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			}
			crcTable[n] = c >>> 0;
		}
	}
	let crc = (previous ^ 0xffffffff) >>> 0;
	for (let i = 0; i < data.length; i++) {
		crc = (crcTable[(crc ^ data[i]) & 0xff] as number) ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export function crc32(data: Uint8Array, previous = 0): number {
	const native = (zlib as unknown as { crc32?: (d: Uint8Array, v?: number) => number }).crc32;
	return (typeof native === "function" ? native(data, previous) : fallbackCrc32(data, previous)) >>> 0;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toDosDateTime(date: Date) {
	const year = Math.max(1980, date.getFullYear());
	return {
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
	};
}

function zip64Extra(values: number[]): Buffer {
	const extra = Buffer.alloc(4 + values.length * 8);
	extra.writeUInt16LE(0x0001, 0);
	extra.writeUInt16LE(values.length * 8, 2);
	values.forEach((value, index) => {
		extra.writeBigUInt64LE(BigInt(value), 4 + index * 8);
	});
	return extra;
}

// ── writer ───────────────────────────────────────────────────────────────────

type CentralRecord = {
	name: Buffer;
	crc: number;
	size: number;
	offset: number;
	flags: number;
	zip64: boolean;
	dosTime: number;
	dosDate: number;
};

export type ZipWriterOptions = {
	/** Force Zip64 structures even for small archives (used by tests). */
	forceZip64?: boolean;
};

export class ZipWriter {
	private offset = 0;
	private readonly records: CentralRecord[] = [];
	private closed = false;

	private constructor(
		private readonly handle: FileHandle,
		private readonly options: ZipWriterOptions,
	) {}

	static async create(filePath: string, options: ZipWriterOptions = {}): Promise<ZipWriter> {
		const handle = await fs.open(filePath, "w");
		return new ZipWriter(handle, options);
	}

	private async write(buffer: Buffer): Promise<void> {
		let written = 0;
		while (written < buffer.length) {
			const { bytesWritten } = await this.handle.write(
				buffer,
				written,
				buffer.length - written,
				null,
			);
			written += bytesWritten;
		}
		this.offset += buffer.length;
	}

	private buildLocalHeader(input: {
		name: Buffer;
		flags: number;
		crc: number;
		size: number;
		zip64: boolean;
		dosTime: number;
		dosDate: number;
	}): Buffer {
		const hasDescriptor = (input.flags & FLAG_DESCRIPTOR) !== 0;
		const extra = input.zip64
			? zip64Extra(hasDescriptor ? [0, 0] : [input.size, input.size])
			: Buffer.alloc(0);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(SIG_LOCAL, 0);
		header.writeUInt16LE(input.zip64 ? 45 : 20, 4);
		header.writeUInt16LE(input.flags, 6);
		header.writeUInt16LE(0, 8); // method: stored
		header.writeUInt16LE(input.dosTime, 10);
		header.writeUInt16LE(input.dosDate, 12);
		header.writeUInt32LE(hasDescriptor ? 0 : input.crc, 14);
		const sizeField = input.zip64 ? U32_MAX : hasDescriptor ? 0 : input.size;
		header.writeUInt32LE(sizeField, 18);
		header.writeUInt32LE(sizeField, 22);
		header.writeUInt16LE(input.name.length, 26);
		header.writeUInt16LE(extra.length, 28);
		return Buffer.concat([header, input.name, extra]);
	}

	/** Adds a small in-memory entry (manifest, project JSON). */
	async addBuffer(name: string, data: Buffer | string, mtime = new Date()): Promise<void> {
		const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		const nameBuffer = Buffer.from(name, "utf8");
		const { date, time } = toDosDateTime(mtime);
		const zip64 = Boolean(this.options.forceZip64) || body.length >= U32_MAX;
		const crc = crc32(body);
		const offset = this.offset;
		await this.write(
			this.buildLocalHeader({
				name: nameBuffer,
				flags: FLAG_UTF8,
				crc,
				size: body.length,
				zip64,
				dosTime: time,
				dosDate: date,
			}),
		);
		await this.write(body);
		this.records.push({
			name: nameBuffer,
			crc,
			size: body.length,
			offset,
			flags: FLAG_UTF8,
			zip64,
			dosTime: time,
			dosDate: date,
		});
	}

	/** Streams a file from disk into the archive without loading it into memory. */
	async addFile(
		name: string,
		sourcePath: string,
		onBytes?: (bytes: number) => void,
	): Promise<void> {
		const stat = await fs.stat(sourcePath);
		if (!stat.isFile()) {
			throw new Error(`Not a file: ${sourcePath}`);
		}
		const nameBuffer = Buffer.from(name, "utf8");
		const { date, time } = toDosDateTime(stat.mtime);
		const zip64 = Boolean(this.options.forceZip64) || stat.size >= U32_MAX;
		const flags = FLAG_UTF8 | FLAG_DESCRIPTOR;
		const offset = this.offset;

		await this.write(
			this.buildLocalHeader({
				name: nameBuffer,
				flags,
				crc: 0,
				size: stat.size,
				zip64,
				dosTime: time,
				dosDate: date,
			}),
		);

		let crc = 0;
		let total = 0;
		const source = createReadStream(sourcePath, { highWaterMark: IO_CHUNK_BYTES });
		try {
			for await (const chunk of source) {
				const buffer = chunk as Buffer;
				crc = crc32(buffer, crc);
				total += buffer.length;
				await this.write(buffer);
				onBytes?.(buffer.length);
			}
		} finally {
			source.destroy();
		}
		if (total !== stat.size) {
			throw new Error(`File changed while it was being exported: ${sourcePath}`);
		}

		const descriptor = Buffer.alloc(zip64 ? 24 : 16);
		descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
		descriptor.writeUInt32LE(crc, 4);
		if (zip64) {
			descriptor.writeBigUInt64LE(BigInt(total), 8);
			descriptor.writeBigUInt64LE(BigInt(total), 16);
		} else {
			descriptor.writeUInt32LE(total, 8);
			descriptor.writeUInt32LE(total, 12);
		}
		await this.write(descriptor);

		this.records.push({
			name: nameBuffer,
			crc,
			size: total,
			offset,
			flags,
			zip64,
			dosTime: time,
			dosDate: date,
		});
	}

	/** Writes the central directory and closes the file. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			const centralStart = this.offset;
			for (const record of this.records) {
				const needsSize64 = record.zip64;
				const needsOffset64 = record.offset >= U32_MAX;
				const extraValues: number[] = [];
				if (needsSize64) extraValues.push(record.size, record.size);
				if (needsOffset64) extraValues.push(record.offset);
				const extra = extraValues.length ? zip64Extra(extraValues) : Buffer.alloc(0);

				const entry = Buffer.alloc(46);
				entry.writeUInt32LE(SIG_CENTRAL, 0);
				entry.writeUInt16LE(extraValues.length ? 45 : 20, 4); // version made by
				entry.writeUInt16LE(extraValues.length ? 45 : 20, 6); // version needed
				entry.writeUInt16LE(record.flags, 8);
				entry.writeUInt16LE(0, 10); // method: stored
				entry.writeUInt16LE(record.dosTime, 12);
				entry.writeUInt16LE(record.dosDate, 14);
				entry.writeUInt32LE(record.crc, 16);
				entry.writeUInt32LE(needsSize64 ? U32_MAX : record.size, 20);
				entry.writeUInt32LE(needsSize64 ? U32_MAX : record.size, 24);
				entry.writeUInt16LE(record.name.length, 28);
				entry.writeUInt16LE(extra.length, 30);
				entry.writeUInt16LE(0, 32); // comment length
				entry.writeUInt16LE(0, 34); // disk number
				entry.writeUInt16LE(0, 36); // internal attributes
				entry.writeUInt32LE(0, 38); // external attributes
				entry.writeUInt32LE(needsOffset64 ? U32_MAX : record.offset, 42);
				await this.write(Buffer.concat([entry, record.name, extra]));
			}
			const centralSize = this.offset - centralStart;

			const needsZip64End =
				Boolean(this.options.forceZip64) ||
				this.records.length >= U16_MAX ||
				centralStart >= U32_MAX ||
				centralSize >= U32_MAX;

			if (needsZip64End) {
				const end64Offset = this.offset;
				const end64 = Buffer.alloc(56);
				end64.writeUInt32LE(SIG_EOCD64, 0);
				end64.writeBigUInt64LE(44n, 4);
				end64.writeUInt16LE(45, 12);
				end64.writeUInt16LE(45, 14);
				end64.writeUInt32LE(0, 16);
				end64.writeUInt32LE(0, 20);
				end64.writeBigUInt64LE(BigInt(this.records.length), 24);
				end64.writeBigUInt64LE(BigInt(this.records.length), 32);
				end64.writeBigUInt64LE(BigInt(centralSize), 40);
				end64.writeBigUInt64LE(BigInt(centralStart), 48);
				await this.write(end64);

				const locator = Buffer.alloc(20);
				locator.writeUInt32LE(SIG_LOCATOR64, 0);
				locator.writeUInt32LE(0, 4);
				locator.writeBigUInt64LE(BigInt(end64Offset), 8);
				locator.writeUInt32LE(1, 16);
				await this.write(locator);
			}

			const eocd = Buffer.alloc(22);
			eocd.writeUInt32LE(SIG_EOCD, 0);
			eocd.writeUInt16LE(0, 4);
			eocd.writeUInt16LE(0, 6);
			eocd.writeUInt16LE(needsZip64End ? U16_MAX : this.records.length, 8);
			eocd.writeUInt16LE(needsZip64End ? U16_MAX : this.records.length, 10);
			eocd.writeUInt32LE(needsZip64End ? U32_MAX : centralSize, 12);
			eocd.writeUInt32LE(needsZip64End ? U32_MAX : centralStart, 16);
			eocd.writeUInt16LE(0, 20);
			await this.write(eocd);
		} finally {
			await this.handle.close();
		}
	}

	/** Closes the underlying file without finishing the archive (error paths). */
	async abort(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.handle.close().catch(() => undefined);
	}
}

// ── reader ───────────────────────────────────────────────────────────────────

export type ZipEntry = {
	name: string;
	method: number;
	flags: number;
	crc: number;
	compressedSize: number;
	size: number;
	offset: number;
	isDirectory: boolean;
};

export class ZipReader {
	private constructor(
		private readonly filePath: string,
		private readonly handle: FileHandle,
		readonly entries: ZipEntry[],
	) {}

	static async open(filePath: string): Promise<ZipReader> {
		const handle = await fs.open(filePath, "r");
		try {
			const entries = await ZipReader.readDirectory(handle);
			return new ZipReader(filePath, handle, entries);
		} catch (error) {
			await handle.close().catch(() => undefined);
			throw error;
		}
	}

	private static async readAt(handle: FileHandle, position: number, length: number) {
		const buffer = Buffer.alloc(length);
		let filled = 0;
		while (filled < length) {
			const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		if (filled !== length) {
			throw new Error("Unexpected end of ZIP file");
		}
		return buffer;
	}

	private static async readDirectory(handle: FileHandle): Promise<ZipEntry[]> {
		const { size: fileSize } = await handle.stat();
		const tailLength = Math.min(fileSize, 22 + U16_MAX);
		if (tailLength < 22) {
			throw new Error("Not a ZIP file");
		}
		const tailStart = fileSize - tailLength;
		const tail = await ZipReader.readAt(handle, tailStart, tailLength);

		let eocdIndex = -1;
		for (let i = tail.length - 22; i >= 0; i--) {
			if (
				tail.readUInt32LE(i) === SIG_EOCD &&
				i + 22 + tail.readUInt16LE(i + 20) <= tail.length
			) {
				eocdIndex = i;
				break;
			}
		}
		if (eocdIndex < 0) {
			throw new Error("Not a ZIP file (end of central directory not found)");
		}

		let entryCount = tail.readUInt16LE(eocdIndex + 10);
		let centralSize = tail.readUInt32LE(eocdIndex + 12);
		let centralOffset = tail.readUInt32LE(eocdIndex + 16);

		if (entryCount === U16_MAX || centralSize === U32_MAX || centralOffset === U32_MAX) {
			const locatorIndex = eocdIndex - 20;
			if (locatorIndex < 0 || tail.readUInt32LE(locatorIndex) !== SIG_LOCATOR64) {
				throw new Error("Corrupt ZIP64 archive (locator not found)");
			}
			const end64Offset = Number(tail.readBigUInt64LE(locatorIndex + 8));
			const end64 = await ZipReader.readAt(handle, end64Offset, 56);
			if (end64.readUInt32LE(0) !== SIG_EOCD64) {
				throw new Error("Corrupt ZIP64 archive (end record not found)");
			}
			entryCount = Number(end64.readBigUInt64LE(32));
			centralSize = Number(end64.readBigUInt64LE(40));
			centralOffset = Number(end64.readBigUInt64LE(48));
		}

		if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
			throw new Error("ZIP central directory is too large");
		}
		const central = await ZipReader.readAt(handle, centralOffset, centralSize);

		const entries: ZipEntry[] = [];
		let position = 0;
		for (let index = 0; index < entryCount; index++) {
			if (position + 46 > central.length || central.readUInt32LE(position) !== SIG_CENTRAL) {
				throw new Error("Corrupt ZIP central directory");
			}
			const flags = central.readUInt16LE(position + 8);
			const method = central.readUInt16LE(position + 10);
			const crc = central.readUInt32LE(position + 16);
			let compressedSize = central.readUInt32LE(position + 20);
			let uncompressedSize = central.readUInt32LE(position + 24);
			const nameLength = central.readUInt16LE(position + 28);
			const extraLength = central.readUInt16LE(position + 30);
			const commentLength = central.readUInt16LE(position + 32);
			let offset = central.readUInt32LE(position + 42);

			const nameStart = position + 46;
			const extraStart = nameStart + nameLength;
			const nextPosition = extraStart + extraLength + commentLength;
			if (nextPosition > central.length) {
				throw new Error("Corrupt ZIP central directory");
			}

			// Zip64 extended information: only fields whose 32-bit value is saturated.
			let cursor = extraStart;
			const extraEnd = extraStart + extraLength;
			while (cursor + 4 <= extraEnd) {
				const id = central.readUInt16LE(cursor);
				const length = central.readUInt16LE(cursor + 2);
				const dataStart = cursor + 4;
				if (id === 0x0001) {
					let at = dataStart;
					if (uncompressedSize === U32_MAX) {
						uncompressedSize = Number(central.readBigUInt64LE(at));
						at += 8;
					}
					if (compressedSize === U32_MAX) {
						compressedSize = Number(central.readBigUInt64LE(at));
						at += 8;
					}
					if (offset === U32_MAX) {
						offset = Number(central.readBigUInt64LE(at));
					}
				}
				cursor = dataStart + length;
			}

			const rawName = central.subarray(nameStart, extraStart);
			const name = (flags & FLAG_UTF8 ? rawName.toString("utf8") : rawName.toString("latin1"))
				.split("\\")
				.join("/");

			entries.push({
				name,
				method,
				flags,
				crc,
				compressedSize,
				size: uncompressedSize,
				offset,
				isDirectory: name.endsWith("/"),
			});
			position = nextPosition;
		}
		return entries;
	}

	getEntry(name: string): ZipEntry | undefined {
		return this.entries.find((entry) => entry.name === name);
	}

	private async locateData(entry: ZipEntry): Promise<number> {
		if (entry.flags & FLAG_ENCRYPTED) {
			throw new Error(`Encrypted ZIP entries are not supported: ${entry.name}`);
		}
		if (entry.method !== 0 && entry.method !== 8) {
			throw new Error(`Unsupported ZIP compression method ${entry.method}: ${entry.name}`);
		}
		const header = await ZipReader.readAt(this.handle, entry.offset, 30);
		if (header.readUInt32LE(0) !== SIG_LOCAL) {
			throw new Error(`Corrupt ZIP entry header: ${entry.name}`);
		}
		return entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
	}

	private createVerifier(entry: ZipEntry, onBytes?: (bytes: number) => void) {
		let crc = 0;
		let total = 0;
		const transform = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				total += chunk.length;
				if (total > entry.size) {
					callback(new Error(`ZIP entry is larger than declared: ${entry.name}`));
					return;
				}
				crc = crc32(chunk, crc);
				onBytes?.(chunk.length);
				callback(null, chunk);
			},
			flush(callback) {
				if (total !== entry.size || crc !== entry.crc) {
					callback(new Error(`ZIP entry is corrupt (size or checksum mismatch): ${entry.name}`));
					return;
				}
				callback();
			},
		});
		return transform;
	}

	/** Streams one entry to `destinationPath`, verifying size and CRC-32. */
	async extractTo(
		entry: ZipEntry,
		destinationPath: string,
		onBytes?: (bytes: number) => void,
	): Promise<void> {
		const dataStart = await this.locateData(entry);
		try {
			if (entry.compressedSize === 0) {
				if (entry.size !== 0 || entry.crc !== 0) {
					throw new Error(`ZIP entry is corrupt (size or checksum mismatch): ${entry.name}`);
				}
				await fs.writeFile(destinationPath, "");
				return;
			}
			const source = createReadStream(this.filePath, {
				start: dataStart,
				end: dataStart + entry.compressedSize - 1,
				highWaterMark: IO_CHUNK_BYTES,
			});
			const verifier = this.createVerifier(entry, onBytes);
			const sink = createWriteStream(destinationPath);
			if (entry.method === 8) {
				await pipeline(source, zlib.createInflateRaw(), verifier, sink);
			} else {
				await pipeline(source, verifier, sink);
			}
		} catch (error) {
			await fs.rm(destinationPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	/** Reads a small text entry (project JSON, manifest). */
	async readText(entry: ZipEntry): Promise<string> {
		if (entry.size > MAX_TEXT_ENTRY_BYTES) {
			throw new Error(`ZIP entry is too large to read as text: ${entry.name}`);
		}
		const dataStart = await this.locateData(entry);
		if (entry.compressedSize === 0) {
			return "";
		}
		const raw = await ZipReader.readAt(this.handle, dataStart, entry.compressedSize);
		const body = entry.method === 8 ? zlib.inflateRawSync(raw) : raw;
		if (body.length !== entry.size || crc32(body) !== entry.crc) {
			throw new Error(`ZIP entry is corrupt (size or checksum mismatch): ${entry.name}`);
		}
		return body.toString("utf8");
	}

	async close(): Promise<void> {
		await this.handle.close().catch(() => undefined);
	}
}
