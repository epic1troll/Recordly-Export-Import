import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeProjectFileAtomically } from "../atomicSave";
import {
	BUNDLE_MANIFEST_ENTRY,
	BUNDLE_PROJECT_ENTRY,
	BUNDLE_VERSION,
	isSafeBundleEntryName,
	planBundle,
	rewriteForExport,
	rewriteForImport,
} from "./bundleCore";
import { ZipReader, ZipWriter } from "./zipStore";

export type BundleProgress = { doneBytes: number; totalBytes: number };

export type ExportBundleResult = {
	path: string;
	fileCount: number;
	totalBytes: number;
	missing: string[];
};

export type ImportBundleResult = {
	projectPath: string;
	mediaDirectory: string;
	projectName: string;
};

type BundleManifest = {
	version?: unknown;
	projectName?: unknown;
};

function parseProjectJson(content: string): unknown {
	return JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
}

/** Filesystem-safe name without extension, same character rules as normal project saves. */
export function sanitizeBundleProjectName(name: string): string {
	const cleaned = Array.from(name.replace(/[<>:"/\\|?*]/g, ""))
		.filter((character) => character.charCodeAt(0) > 31)
		.join("")
		.replace(/\s+/g, " ")
		.replace(/[. ]+$/g, "")
		.trim();
	return cleaned || "Project";
}

async function pathExists(target: string) {
	return fs
		.access(target)
		.then(() => true)
		.catch(() => false);
}

// ── export ───────────────────────────────────────────────────────────────────

export async function exportProjectBundle(
	projectPath: string,
	destinationPath: string,
	options: { appVersion?: string; onProgress?: (progress: BundleProgress) => void } = {},
): Promise<ExportBundleResult> {
	const project = parseProjectJson(await fs.readFile(projectPath, "utf-8"));
	if (!project || typeof project !== "object" || Array.isArray(project)) {
		throw new Error("Invalid project file format");
	}

	const plan = planBundle(project);
	const portableProject = rewriteForExport(project, plan);
	const manifest = {
		version: BUNDLE_VERSION,
		createdAt: new Date().toISOString(),
		appVersion: options.appVersion,
		projectName: path.basename(projectPath, path.extname(projectPath)),
		files: plan.files.map((file) => ({
			path: file.entryName,
			size: file.size,
			role: file.role,
		})),
	};

	// Write next to the destination first so a failed export never leaves a broken bundle.
	const temporaryPath = `${destinationPath}.part`;
	let doneBytes = 0;
	const writer = await ZipWriter.create(temporaryPath);
	try {
		await writer.addBuffer(BUNDLE_PROJECT_ENTRY, JSON.stringify(portableProject, null, 2));
		await writer.addBuffer(BUNDLE_MANIFEST_ENTRY, JSON.stringify(manifest, null, 2));
		for (const file of plan.files) {
			await writer.addFile(file.entryName, file.sourcePath, (bytes) => {
				doneBytes += bytes;
				options.onProgress?.({ doneBytes, totalBytes: plan.totalBytes });
			});
		}
		await writer.close();
		await fs.rename(temporaryPath, destinationPath);
	} catch (error) {
		await writer.abort();
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}

	return {
		path: destinationPath,
		fileCount: plan.files.length,
		totalBytes: plan.totalBytes,
		missing: plan.missing,
	};
}

// ── import ───────────────────────────────────────────────────────────────────

/**
 * Unpacks a bundle: the project file goes to `projectsDirectory`, media to
 * `<mediaRootDirectory>/<project name>/`. Nothing existing is overwritten; a numeric suffix is
 * added if the name is taken.
 */
export async function importProjectBundle(
	bundlePath: string,
	locations: { projectsDirectory: string; mediaRootDirectory: string },
	options: { onProgress?: (progress: BundleProgress) => void } = {},
): Promise<ImportBundleResult> {
	const reader = await ZipReader.open(bundlePath);
	let mediaDirectory: string | null = null;
	let projectPath: string | null = null;
	try {
		const manifestEntry = reader.getEntry(BUNDLE_MANIFEST_ENTRY);
		const projectEntry = reader.getEntry(BUNDLE_PROJECT_ENTRY);
		if (!manifestEntry || !projectEntry) {
			throw new Error("This is not a Recordly project bundle.");
		}
		const manifest = JSON.parse(await reader.readText(manifestEntry)) as BundleManifest;
		if (typeof manifest.version !== "number" || manifest.version > BUNDLE_VERSION) {
			throw new Error("This bundle was created by a newer version of Recordly.");
		}

		const requestedName = sanitizeBundleProjectName(
			typeof manifest.projectName === "string" && manifest.projectName.trim()
				? manifest.projectName
				: path.basename(bundlePath, path.extname(bundlePath)),
		);

		await fs.mkdir(locations.projectsDirectory, { recursive: true });
		await fs.mkdir(locations.mediaRootDirectory, { recursive: true });

		let projectName = requestedName;
		for (let attempt = 1; attempt < 1000; attempt++) {
			projectName = attempt === 1 ? requestedName : `${requestedName} (${attempt})`;
			const candidateProject = path.join(locations.projectsDirectory, `${projectName}.recordly`);
			const candidateMedia = path.join(locations.mediaRootDirectory, projectName);
			if (!(await pathExists(candidateProject)) && !(await pathExists(candidateMedia))) {
				await fs.mkdir(candidateMedia); // non-recursive: fails if somebody took it meanwhile
				mediaDirectory = candidateMedia;
				projectPath = candidateProject;
				break;
			}
		}
		if (!mediaDirectory || !projectPath) {
			throw new Error("Could not find a free project name.");
		}

		const mediaEntries = reader.entries.filter(
			(entry) => !entry.isDirectory && entry.name.startsWith("media/"),
		);
		const totalBytes = mediaEntries.reduce((sum, entry) => sum + entry.size, 0);
		let doneBytes = 0;
		const root = path.resolve(mediaDirectory);
		for (const entry of mediaEntries) {
			if (!isSafeBundleEntryName(entry.name)) {
				throw new Error(`Unsafe entry in bundle: ${entry.name}`);
			}
			const target = path.resolve(root, ...entry.name.split("/"));
			if (!target.startsWith(root + path.sep)) {
				throw new Error(`Unsafe entry in bundle: ${entry.name}`);
			}
			await fs.mkdir(path.dirname(target), { recursive: true });
			await reader.extractTo(entry, target, (bytes) => {
				doneBytes += bytes;
				options.onProgress?.({ doneBytes, totalBytes });
			});
		}

		const restored = rewriteForImport(parseProjectJson(await reader.readText(projectEntry)), root);
		if (!restored || typeof restored !== "object" || Array.isArray(restored)) {
			throw new Error("Invalid project file inside the bundle.");
		}
		// A fresh id keeps an imported copy from being mistaken for the original project.
		const withNewId = { ...(restored as Record<string, unknown>), projectId: randomUUID() };
		await writeProjectFileAtomically(projectPath, JSON.stringify(withNewId, null, 2));

		return { projectPath, mediaDirectory, projectName };
	} catch (error) {
		if (mediaDirectory) {
			await fs.rm(mediaDirectory, { recursive: true, force: true }).catch(() => undefined);
		}
		if (projectPath) {
			await fs.rm(projectPath, { force: true }).catch(() => undefined);
		}
		throw error;
	} finally {
		await reader.close();
	}
}
