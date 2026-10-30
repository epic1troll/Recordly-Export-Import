import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportProjectBundle, importProjectBundle } from "./projectBundle";
import { ZipReader, ZipWriter } from "./zipStore";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "recordly-bundle-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function exists(target: string) {
	return stat(target).then(
		() => true,
		() => false,
	);
}

async function createMachineA() {
	const rec = path.join(root, "A", "Recordings");
	const music = path.join(root, "A", "Music");
	await mkdir(rec, { recursive: true });
	await mkdir(music, { recursive: true });
	const video = path.join(rec, "recording-1.mp4");
	const files: Record<string, string> = {
		[video]: "VIDEO-BYTES".repeat(1000),
		[`${video}.cursor.json`]: '{"samples":[1,2,3]}',
		[path.join(rec, "recording-1-webcam.webm")]: "WEBCAM",
		[path.join(rec, "recording-1.mic.wav")]: "MIC",
		[path.join(rec, "recording-1.recordly-session.json")]: '{"version":2}',
		[path.join(rec, "recording-2.mp4")]: "SOMEONE ELSE",
		[path.join(music, "song.mp3")]: "SONG",
	};
	for (const [file, content] of Object.entries(files)) await writeFile(file, content);
	const projectPath = path.join(root, "A", "My Demo.recordly");
	await writeFile(
		projectPath,
		JSON.stringify({
			version: 2,
			projectId: "original-id",
			videoPath: video,
			editor: {
				webcam: { sourcePath: path.join(rec, "recording-1-webcam.webm") },
				audioTracks: [{ sourcePath: path.join(music, "song.mp3") }],
				wallpaper: "/wallpapers/tahoe-light.jpg",
				missing: path.join(rec, "deleted.mp4"),
			},
		}),
	);
	return { projectPath, video, rec };
}

describe("project bundle round trip", () => {
	it("exports a project with its media and opens it on 'another computer'", async () => {
		const { projectPath, rec } = await createMachineA();
		const bundlePath = path.join(root, "My Demo.recordlypack");
		const progress: number[] = [];
		const exported = await exportProjectBundle(projectPath, bundlePath, {
			appVersion: "1.4.0",
			onProgress: (p) => progress.push(p.doneBytes),
		});

		expect(exported.fileCount).toBe(6); // video, cursor, webcam, mic, session, song
		expect(exported.missing).toEqual([path.join(rec, "deleted.mp4")]);
		expect(progress.at(-1)).toBe(exported.totalBytes);
		expect(await exists(`${bundlePath}.part`)).toBe(false);

		const reader = await ZipReader.open(bundlePath);
		const names = reader.entries.map((entry) => entry.name);
		await reader.close();
		expect(names).toContain("project.recordly");
		expect(names).toContain("bundle.json");
		expect(names.some((name) => name.includes("recording-2"))).toBe(false);

		// "another computer": the originals are gone
		await rm(path.join(root, "A"), { recursive: true, force: true });

		const projectsDirectory = path.join(root, "B", "Projects");
		const mediaRootDirectory = path.join(root, "B", "Recordings", "Imported");
		const imported = await importProjectBundle(bundlePath, { projectsDirectory, mediaRootDirectory });

		expect(imported.projectPath).toBe(path.join(projectsDirectory, "My Demo.recordly"));
		const project = JSON.parse(await readFile(imported.projectPath, "utf8"));
		expect(project.projectId).not.toBe("original-id");
		expect(project.editor.wallpaper).toBe("/wallpapers/tahoe-light.jpg");
		expect(await readFile(project.videoPath, "utf8")).toBe("VIDEO-BYTES".repeat(1000));
		expect(await readFile(project.editor.webcam.sourcePath, "utf8")).toBe("WEBCAM");
		expect(await readFile(project.editor.audioTracks[0].sourcePath, "utf8")).toBe("SONG");

		// Recordly's naming conventions still hold next to the imported video
		const videoDirectory = path.dirname(project.videoPath);
		expect((await readdir(videoDirectory)).sort()).toEqual([
			"recording-1-webcam.webm",
			"recording-1.mic.wav",
			"recording-1.mp4",
			"recording-1.mp4.cursor.json",
			"recording-1.recordly-session.json",
		]);
		expect(path.dirname(project.editor.webcam.sourcePath)).toBe(videoDirectory);

		// importing again never overwrites
		const second = await importProjectBundle(bundlePath, { projectsDirectory, mediaRootDirectory });
		expect(second.projectPath).toBe(path.join(projectsDirectory, "My Demo (2).recordly"));
		expect(second.mediaDirectory).not.toBe(imported.mediaDirectory);
	});

	it("does not leave a partial bundle when export fails", async () => {
		const { projectPath, video } = await createMachineA();
		const bundlePath = path.join(root, "fail.recordlypack");
		await rm(video); // referenced file vanishes -> reported missing, export still works
		const result = await exportProjectBundle(projectPath, bundlePath);
		expect(result.missing.length).toBeGreaterThan(0);
		await expect(
			exportProjectBundle(path.join(root, "nope.recordly"), path.join(root, "x.recordlypack")),
		).rejects.toThrow();
		expect(await exists(path.join(root, "x.recordlypack.part"))).toBe(false);
	});
});

describe("hostile or broken bundles", () => {
	async function craft(entries: Record<string, string>, version = 1) {
		const file = path.join(root, `crafted-${Math.random().toString(36).slice(2)}.recordlypack`);
		const writer = await ZipWriter.create(file);
		await writer.addBuffer("bundle.json", JSON.stringify({ version, projectName: "Evil" }));
		for (const [name, content] of Object.entries(entries)) await writer.addBuffer(name, content);
		await writer.close();
		return file;
	}
	const locations = () => ({
		projectsDirectory: path.join(root, "B", "Projects"),
		mediaRootDirectory: path.join(root, "B", "Media"),
	});

	it("rejects path traversal in the project JSON and cleans up", async () => {
		const bundle = await craft({
			"project.recordly": JSON.stringify({ videoPath: "recordly-bundle://../../../evil.mp4" }),
		});
		await expect(importProjectBundle(bundle, locations())).rejects.toThrow(/unsafe/i);
		expect(await readdir(locations().mediaRootDirectory)).toEqual([]);
		expect(await readdir(locations().projectsDirectory)).toEqual([]);
	});

	it("rejects path traversal in entry names", async () => {
		const bundle = await craft({
			"project.recordly": "{}",
			"media/../../escape.txt": "x",
		});
		await expect(importProjectBundle(bundle, locations())).rejects.toThrow(/unsafe/i);
		expect(await exists(path.join(root, "B", "escape.txt"))).toBe(false);
		expect(await readdir(locations().mediaRootDirectory)).toEqual([]);
	});

	it("rejects bundles from a newer format version and non-bundles", async () => {
		const newer = await craft({ "project.recordly": "{}" }, 99);
		await expect(importProjectBundle(newer, locations())).rejects.toThrow(/newer/i);

		const notBundle = path.join(root, "plain.zip");
		const writer = await ZipWriter.create(notBundle);
		await writer.addBuffer("hello.txt", "hi");
		await writer.close();
		await expect(importProjectBundle(notBundle, locations())).rejects.toThrow(/not a Recordly/i);
	});
});
