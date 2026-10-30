/**
 * Portable project bundles (.recordlypack).
 *
 * A .recordly file stores absolute paths to its media, so it breaks on another computer.
 * A bundle is a zip with the project JSON (paths replaced by markers), a manifest and every
 * media file the project references:
 *
 *   project.recordly            paths look like "recordly-bundle://media/001/video.mp4"
 *   bundle.json                 manifest
 *   media/001/video.mp4         files are grouped by their original folder, so siblings stay
 *   media/001/video.mp4.cursor.json   siblings (cursor telemetry, webcam, audio) and keep
 *   media/002/music.mp3         the file-name conventions Recordly relies on
 *
 * This module is pure Node (no Electron) so it can be unit-tested.
 */

import { statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUNDLE_VERSION = 1;
export const PROJECT_BUNDLE_EXTENSION = "recordlypack";
export const BUNDLE_PROJECT_ENTRY = "project.recordly";
export const BUNDLE_MANIFEST_ENTRY = "bundle.json";

const PATH_MARKER = "recordly-bundle://";
const URL_MARKER = "recordly-bundle-url://";

// Used only to decide whether a *missing* path is worth warning about.
const LIKELY_FILE_PATTERN =
	/\.(mp4|m4v|mov|webm|mkv|avi|gif|wav|mp3|m4a|aac|ogg|flac|png|jpe?g|webp|avif|svg|json)$/i;

export type BundleFile = {
	sourcePath: string;
	/** Path inside the zip, forward slashes: media/001/video.mp4 */
	entryName: string;
	size: number;
	/** "media" = referenced by the project, "sidecar" = Recordly file that belongs to the video. */
	role: "media" | "sidecar";
};

export type BundlePlan = {
	files: BundleFile[];
	/** normalized source path -> entry name (referenced media only) */
	lookup: Map<string, string>;
	/** Referenced files that look like media but are not on disk. */
	missing: string[];
	totalBytes: number;
};

type LocalReference = { absolutePath: string; kind: "path" | "url" };

// ── helpers ──────────────────────────────────────────────────────────────────

export function deepMapStrings(value: unknown, transform: (text: string) => string): unknown {
	if (typeof value === "string") {
		return transform(value);
	}
	if (Array.isArray(value)) {
		return value.map((item) => deepMapStrings(item, transform));
	}
	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			result[key] = deepMapStrings(item, transform);
		}
		return result;
	}
	return value;
}

function toLocalReference(value: string): LocalReference | null {
	if (value.length < 3 || value.length > 4096 || value.includes("\n")) {
		return null;
	}
	// Built-in wallpapers are app assets ("/wallpapers/x.jpg"), not user files.
	if (value.startsWith("/wallpapers/")) {
		return null;
	}
	if (/^file:\/\//i.test(value)) {
		try {
			return { absolutePath: fileURLToPath(value), kind: "url" };
		} catch {
			return null;
		}
	}
	const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
	const isPosixAbsolute = value.startsWith("/") && !value.startsWith("//");
	if (isWindowsAbsolute || isPosixAbsolute) {
		return { absolutePath: value, kind: "path" };
	}
	return null;
}

function normalizeKey(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" || process.platform === "darwin"
		? resolved.toLowerCase()
		: resolved;
}

function statFile(filePath: string) {
	try {
		const stat = statSync(filePath);
		return stat.isFile() ? stat : null;
	} catch {
		return null;
	}
}

/**
 * Same rules the recording library uses to decide which files belong to one recording
 * (cursor telemetry, webcam, companion audio, session manifest). Keeping them identical means
 * a bundled recording opens in the importing app exactly like a native one.
 */
export function belongsToRecording(name: string, video: string): boolean {
	const stem = video.slice(0, video.length - path.extname(video).length);
	return (
		name === video ||
		name === `${video}.cursor.json` ||
		(name.startsWith(`${stem}.`) &&
			/\.(?:system|mic|microphone|audio|webcam)\.(?:wav|webm|mp4|m4a)(?:\.json)?$/i.test(name)) ||
		name === `${stem}.recordly-session.json` ||
		name === `${stem}.recording-session.json` ||
		(name.startsWith(`${stem}-webcam.`) && /\.(?:mp4|webm|mov|mkv|avi)$/i.test(name))
	);
}

// ── export side ──────────────────────────────────────────────────────────────

export function planBundle(project: unknown): BundlePlan {
	const files: BundleFile[] = [];
	const lookup = new Map<string, string>();
	const missing = new Set<string>();
	const groupIdByDirectory = new Map<string, string>();

	const groupIdFor = (directory: string) => {
		const key = normalizeKey(directory);
		let id = groupIdByDirectory.get(key);
		if (!id) {
			id = String(groupIdByDirectory.size + 1).padStart(3, "0");
			groupIdByDirectory.set(key, id);
		}
		return id;
	};

	const addMedia = (absolutePath: string) => {
		const key = normalizeKey(absolutePath);
		if (lookup.has(key)) return;
		const stat = statFile(absolutePath);
		if (!stat) return;
		const resolved = path.resolve(absolutePath);
		const entryName = `media/${groupIdFor(path.dirname(resolved))}/${path.basename(resolved)}`;
		lookup.set(key, entryName);
		files.push({ sourcePath: resolved, entryName, size: stat.size, role: "media" });
	};

	deepMapStrings(project, (text) => {
		const reference = toLocalReference(text);
		if (!reference) return text;
		if (statFile(reference.absolutePath)) {
			addMedia(reference.absolutePath);
		} else if (LIKELY_FILE_PATTERN.test(reference.absolutePath)) {
			missing.add(reference.absolutePath);
		}
		return text;
	});

	// Files that belong to the main recording but are not referenced from the project JSON.
	const primaryVideo =
		project && typeof project === "object" && !Array.isArray(project)
			? (project as { videoPath?: unknown }).videoPath
			: null;
	const primary = typeof primaryVideo === "string" ? toLocalReference(primaryVideo) : null;
	if (primary && lookup.has(normalizeKey(primary.absolutePath))) {
		const videoPath = path.resolve(primary.absolutePath);
		const directory = path.dirname(videoPath);
		const videoName = path.basename(videoPath);
		let siblings: string[] = [];
		try {
			siblings = readdirSync(directory);
		} catch {
			siblings = [];
		}
		for (const sibling of siblings) {
			if (!belongsToRecording(sibling, videoName)) continue;
			const siblingPath = path.join(directory, sibling);
			if (lookup.has(normalizeKey(siblingPath))) continue;
			const stat = statFile(siblingPath);
			if (!stat) continue;
			files.push({
				sourcePath: siblingPath,
				entryName: `media/${groupIdFor(directory)}/${sibling}`,
				size: stat.size,
				role: "sidecar",
			});
		}
	}

	return {
		files,
		lookup,
		missing: [...missing],
		totalBytes: files.reduce((sum, file) => sum + file.size, 0),
	};
}

export function rewriteForExport(project: unknown, plan: BundlePlan): unknown {
	return deepMapStrings(project, (text) => {
		const reference = toLocalReference(text);
		if (!reference) return text;
		const entry = plan.lookup.get(normalizeKey(reference.absolutePath));
		if (!entry) return text;
		return (reference.kind === "url" ? URL_MARKER : PATH_MARKER) + entry;
	});
}

// ── import side ──────────────────────────────────────────────────────────────

/** True if a zip entry name is safe to extract under a target folder. */
export function isSafeBundleEntryName(name: string): boolean {
	if (!name || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\0")) {
		return false;
	}
	return !name.split("/").some((segment) => segment === "..");
}

export function rewriteForImport(project: unknown, rootDirectory: string): unknown {
	const root = path.resolve(rootDirectory);
	return deepMapStrings(project, (text) => {
		let kind: "path" | "url";
		let relative: string;
		if (text.startsWith(URL_MARKER)) {
			kind = "url";
			relative = text.slice(URL_MARKER.length);
		} else if (text.startsWith(PATH_MARKER)) {
			kind = "path";
			relative = text.slice(PATH_MARKER.length);
		} else {
			return text;
		}
		if (!isSafeBundleEntryName(relative)) {
			throw new Error(`Unsafe path in bundle: ${text}`);
		}
		const absolute = path.resolve(root, ...relative.split("/"));
		if (absolute !== root && !absolute.startsWith(root + path.sep)) {
			throw new Error(`Unsafe path in bundle: ${text}`);
		}
		return kind === "url" ? pathToFileURL(absolute).href : absolute;
	});
}
