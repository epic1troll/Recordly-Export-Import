import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	belongsToRecording,
	isSafeBundleEntryName,
	planBundle,
	rewriteForExport,
	rewriteForImport,
} from "./bundleCore";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "recordly-core-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("belongsToRecording", () => {
	it("accepts Recordly's own sidecar files and nothing else", () => {
		const video = "recording-1.mp4";
		for (const name of [
			"recording-1.mp4.cursor.json",
			"recording-1.mic.wav",
			"recording-1.system.m4a",
			"recording-1.recordly-session.json",
			"recording-1-webcam.webm",
		]) {
			expect(belongsToRecording(name, video)).toBe(true);
		}
		for (const name of ["recording-2.mp4", "recording-12.mp4.cursor.json", "recording-1-final.mp4"]) {
			expect(belongsToRecording(name, video)).toBe(false);
		}
	});
});

describe("planBundle / rewrite", () => {
	it("groups by folder, dedupes, ignores wallpapers/plain text and reports missing files", async () => {
		await mkdir(path.join(dir, "rec"));
		await mkdir(path.join(dir, "music"));
		const video = path.join(dir, "rec", "recording-1.mp4");
		const webcam = path.join(dir, "rec", "recording-1-webcam.webm");
		const song = path.join(dir, "music", "song.mp3");
		await writeFile(video, "v");
		await writeFile(webcam, "w");
		await writeFile(song, "s");
		await writeFile(`${video}.cursor.json`, "{}");
		await writeFile(path.join(dir, "rec", "recording-2.mp4"), "other");
		const ghost = path.join(dir, "gone.mp4");

		const project = {
			videoPath: video,
			editor: {
				webcam: { sourcePath: pathToFileURL(webcam).href },
				audioTracks: [{ sourcePath: song }, { sourcePath: song }],
				wallpaper: "/wallpapers/tahoe-light.jpg",
				note: "just text",
				ghost,
			},
		};
		const plan = planBundle(project);

		const names = plan.files.map((file) => file.entryName).sort();
		expect(names).toEqual([
			"media/001/recording-1-webcam.webm",
			"media/001/recording-1.mp4",
			"media/001/recording-1.mp4.cursor.json",
			"media/002/song.mp3",
		]);
		expect(plan.missing).toEqual([ghost]);

		const portable = rewriteForExport(project, plan) as typeof project;
		expect(portable.videoPath).toBe("recordly-bundle://media/001/recording-1.mp4");
		expect(portable.editor.webcam.sourcePath).toBe(
			"recordly-bundle-url://media/001/recording-1-webcam.webm",
		);
		expect(portable.editor.audioTracks[0]?.sourcePath).toBe(portable.editor.audioTracks[1]?.sourcePath);
		expect(portable.editor.wallpaper).toBe("/wallpapers/tahoe-light.jpg");
		expect(portable.editor.note).toBe("just text");
		expect(portable.editor.ghost).toBe(ghost);

		const restored = rewriteForImport(portable, path.join(dir, "elsewhere")) as typeof project;
		expect(restored.videoPath).toBe(path.join(dir, "elsewhere", "media", "001", "recording-1.mp4"));
		expect(restored.editor.webcam.sourcePath.startsWith("file://")).toBe(true);
	});

	it("refuses markers that point outside the import folder", () => {
		expect(() => rewriteForImport({ a: "recordly-bundle://../../x" }, dir)).toThrow(/unsafe/i);
		expect(() => rewriteForImport({ a: "recordly-bundle:///etc/passwd" }, dir)).toThrow(/unsafe/i);
		expect(isSafeBundleEntryName("media/001/a.mp4")).toBe(true);
		expect(isSafeBundleEntryName("media/../a")).toBe(false);
		expect(isSafeBundleEntryName("C:/x")).toBe(false);
	});
});
