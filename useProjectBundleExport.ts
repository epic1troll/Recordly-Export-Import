import { useCallback, useState } from "react";
import { toast } from "@/components/ui/toast";
import type { useI18n } from "@/contexts/I18nContext";
import type { useProjectSaveActions } from "./useProjectSaveActions";

const TOAST_ID = "project-bundle-export";

type Translate = ReturnType<typeof useI18n>["t"];

function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * "Export project with media": packs the project and every media file it uses into one
 * .recordlypack file that can be opened on another computer.
 */
export function useProjectBundleExport(
	saveProject: ReturnType<typeof useProjectSaveActions>["saveProject"],
	t: Translate,
) {
	const [isExportingBundle, setIsExportingBundle] = useState(false);

	const handleExportProjectBundle = useCallback(async () => {
		if (isExportingBundle) return;
		setIsExportingBundle(true);
		let stopListening: (() => void) | null = null;
		try {
			// The bundle is built from the saved project file, so save what is on screen first.
			const saved = await saveProject(false, {
				silent: true,
				remountPreviewAfterSave: false,
				refreshLibraryAfterSave: false,
				captureThumbnail: false,
			});
			if (!saved) {
				toast.error(
					t("editor.project.exportBundleSaveFailed", "Save the project before exporting it."),
				);
				return;
			}

			stopListening = window.electronAPI.onProjectBundleProgress(({ doneBytes, totalBytes }) => {
				const percent = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 100;
				toast(t("editor.project.exportBundleProgress", "Exporting project with media…"), {
					id: TOAST_ID,
					description: `${percent}%`,
					duration: Number.POSITIVE_INFINITY,
				});
			});

			const result = await window.electronAPI.exportProjectBundle();
			if (result.canceled) {
				toast.dismiss(TOAST_ID);
				return;
			}
			if (!result.success) {
				toast.error(
					result.error || result.message || t("editor.project.exportBundleFailed", "Export failed"),
					{ id: TOAST_ID },
				);
				return;
			}

			const missingCount = result.missing?.length ?? 0;
			const summary = `${result.fileCount ?? 0} files · ${formatBytes(result.totalBytes ?? 0)}`;
			const exportedPath = result.path;
			const reveal = exportedPath
				? {
						label: t("editor.project.exportBundleReveal", "Show in folder"),
						onClick: () => void window.electronAPI.revealInFolder(exportedPath),
					}
				: undefined;
			if (missingCount > 0) {
				toast.warning(
					t("editor.project.exportBundleMissing", "Exported, but some media files were not found"),
					{
						id: TOAST_ID,
						description: `${summary} · ${missingCount} missing`,
						action: reveal,
						duration: 10000,
					},
				);
			} else {
				toast.success(t("editor.project.exportBundleDone", "Project exported"), {
					id: TOAST_ID,
					description: summary,
					action: reveal,
					duration: 8000,
				});
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error), { id: TOAST_ID });
		} finally {
			stopListening?.();
			setIsExportingBundle(false);
		}
	}, [isExportingBundle, saveProject, t]);

	return { handleExportProjectBundle, isExportingBundle };
}
