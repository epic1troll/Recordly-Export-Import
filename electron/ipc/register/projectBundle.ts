import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { PROJECT_BUNDLE_EXTENSION } from "../project/bundle/bundleCore";
import { importBundleAndLoadProject } from "../project/bundle/importAndLoad";
import { exportProjectBundle } from "../project/bundle/projectBundle";
import {
	getProjectsDir,
	hasProjectFileExtension,
	isPathInsideDirectory,
	isTrustedProjectPath,
} from "../project/manager";
import { currentProjectPath } from "../state";

const PROGRESS_INTERVAL_MS = 200;

export function registerProjectBundleHandlers() {
	/**
	 * Packs the (already saved) project and all of its media into one .recordlypack file that
	 * can be opened on another computer.
	 */
	ipcMain.handle("export-project-bundle", async (event, requestedProjectPath?: string) => {
		try {
			const projectPath =
				typeof requestedProjectPath === "string" && requestedProjectPath
					? requestedProjectPath
					: currentProjectPath;
			if (!projectPath || !hasProjectFileExtension(projectPath)) {
				return { success: false, message: "Save the project first, then export it." };
			}
			const projectsDir = await getProjectsDir();
			if (!isTrustedProjectPath(projectPath) && !isPathInsideDirectory(projectPath, projectsDir)) {
				return { success: false, message: "Project path is not trusted. Save the project first." };
			}

			const baseName = path.basename(projectPath, path.extname(projectPath));
			const options = {
				title: "Export Project with Media",
				defaultPath: path.join(
					app.getPath("documents"),
					`${baseName}.${PROJECT_BUNDLE_EXTENSION}`,
				),
				filters: [
					{ name: "Recordly Project Bundle", extensions: [PROJECT_BUNDLE_EXTENSION] },
					{ name: "ZIP archive", extensions: ["zip"] },
				],
				properties: ["createDirectory" as const, "showOverwriteConfirmation" as const],
			};
			const window = BrowserWindow.fromWebContents(event.sender);
			const picked = window
				? await dialog.showSaveDialog(window, options)
				: await dialog.showSaveDialog(options);
			if (picked.canceled || !picked.filePath) {
				return { success: false, canceled: true, message: "Export canceled" };
			}
			const destination = /\.(recordlypack|zip)$/i.test(picked.filePath)
				? picked.filePath
				: `${picked.filePath}.${PROJECT_BUNDLE_EXTENSION}`;

			let lastProgressAt = 0;
			const result = await exportProjectBundle(projectPath, destination, {
				appVersion: app.getVersion(),
				onProgress: (progress) => {
					const now = Date.now();
					if (now - lastProgressAt < PROGRESS_INTERVAL_MS && progress.doneBytes < progress.totalBytes) {
						return;
					}
					lastProgressAt = now;
					if (!event.sender.isDestroyed()) {
						event.sender.send("project-bundle-progress", progress);
					}
				},
			});
			return { success: true, ...result };
		} catch (error) {
			console.error("Failed to export project bundle:", error);
			return {
				success: false,
				message: "Failed to export project",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});

	/**
	 * Lets the user pick a .recordlypack (or .zip) bundle, unpacks it with all its media and
	 * returns the loaded project, ready to be applied by the editor.
	 */
	ipcMain.handle("import-project-bundle", async (event) => {
		try {
			const options = {
				title: "Import Project with Media",
				defaultPath: app.getPath("documents"),
				filters: [
					{
						name: "Recordly Project Bundle",
						extensions: [PROJECT_BUNDLE_EXTENSION, "zip"],
					},
				],
				properties: ["openFile" as const],
			};
			const window = BrowserWindow.fromWebContents(event.sender);
			const picked = window
				? await dialog.showOpenDialog(window, options)
				: await dialog.showOpenDialog(options);
			if (picked.canceled || picked.filePaths.length === 0) {
				return { success: false, canceled: true, message: "Import canceled" };
			}
			return await importBundleAndLoadProject(picked.filePaths[0]);
		} catch (error) {
			console.error("Failed to import project bundle:", error);
			return {
				success: false,
				message: "Failed to import project",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	});
}
