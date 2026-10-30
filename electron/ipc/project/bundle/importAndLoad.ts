import path from "node:path";
import { getRecordingsDir } from "../../utils";
import { getProjectsDir, loadProjectFromPath } from "../manager";
import { PROJECT_BUNDLE_EXTENSION } from "./bundleCore";
import { importProjectBundle } from "./projectBundle";

export function hasProjectBundleExtension(filePath: string): boolean {
	return path.extname(filePath).toLowerCase() === `.${PROJECT_BUNDLE_EXTENSION}`;
}

/**
 * Unpacks a .recordlypack into the projects folder (project file) and the recordings folder
 * (media, under "Imported/<project name>"), then loads it exactly like a normal project.
 */
export async function importBundleAndLoadProject(bundlePath: string) {
	try {
		const imported = await importProjectBundle(bundlePath, {
			projectsDirectory: await getProjectsDir(),
			mediaRootDirectory: path.join(await getRecordingsDir(), "Imported"),
		});
		return await loadProjectFromPath(imported.projectPath);
	} catch (error) {
		console.error("Failed to import project bundle:", error);
		return {
			success: false as const,
			canceled: false,
			message: `Failed to import project bundle: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
