import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crc32, ZipReader, ZipWriter } from "./zipStore";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "recordly-zip-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function buildArchive(forceZip64: boolean) {
	const big = Buffer.alloc(3_000_000, 7);
	big.writeUInt32LE(0xdeadbeef, 1_000_000);
	await writeFile(path.join(dir, "big.bin"), big);
	await writeFile(path.join(dir, "empty.bin"), "");
	await writeFile(path.join(dir, "u.txt"), "привіт");
	const archive = path.join(dir, forceZip64 ? "z64.zip" : "z.zip");
	const writer = await ZipWriter.create(archive, { forceZip64 });
	await writer.addBuffer("project.recordly", '{"a":1}');
	await writer.addFile("media/001/big.bin", path.join(dir, "big.bin"));
	await writer.addFile("media/001/empty.bin", path.join(dir, "empty.bin"));
	await writer.addFile("media/002/приклад.txt", path.join(dir, "u.txt"));
	await writer.close();
	return { archive, big };
}

describe("crc32", () => {
	it("matches the reference value", () => {
		expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
		expect(crc32(Buffer.from("6789"), crc32(Buffer.from("12345")))).toBe(0xcbf43926);
	});
});

describe("ZipWriter / ZipReader", () => {
	for (const forceZip64 of [false, true]) {
		it(`round-trips files (zip64=${forceZip64})`, async () => {
			const { archive, big } = await buildArchive(forceZip64);
			const reader = await ZipReader.open(archive);
			expect(reader.entries.map((entry) => entry.name)).toEqual([
				"project.recordly",
				"media/001/big.bin",
				"media/001/empty.bin",
				"media/002/приклад.txt",
			]);
			expect(await reader.readText(reader.getEntry("project.recordly")!)).toBe('{"a":1}');
			await reader.extractTo(reader.getEntry("media/001/big.bin")!, path.join(dir, "out.bin"));
			expect((await readFile(path.join(dir, "out.bin"))).equals(big)).toBe(true);
			await reader.extractTo(reader.getEntry("media/001/empty.bin")!, path.join(dir, "out-empty"));
			expect((await readFile(path.join(dir, "out-empty"))).length).toBe(0);
			await reader.extractTo(reader.getEntry("media/002/приклад.txt")!, path.join(dir, "out-u"));
			expect(await readFile(path.join(dir, "out-u"), "utf8")).toBe("привіт");
			await reader.close();
		});
	}

	it("detects a corrupted entry and removes the partial output", async () => {
		const { archive } = await buildArchive(false);
		const bytes = await readFile(archive);
		bytes[500] ^= 0xff; // inside the first media entry
		await writeFile(archive, bytes);
		const reader = await ZipReader.open(archive);
		const target = path.join(dir, "bad.bin");
		await expect(reader.extractTo(reader.getEntry("media/001/big.bin")!, target)).rejects.toThrow(
			/corrupt/i,
		);
		await expect(readFile(target)).rejects.toThrow();
		await reader.close();
	});

	it("rejects files that are not zip archives", async () => {
		await writeFile(path.join(dir, "x.zip"), Buffer.alloc(100, 1));
		await expect(ZipReader.open(path.join(dir, "x.zip"))).rejects.toThrow();
	});
});
