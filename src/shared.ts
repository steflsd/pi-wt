import { realpathSync } from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function reportMessage(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}

	if (level === "error" || level === "warning") {
		console.error(message);
		return;
	}

	console.log(message);
}

export function cancelIfAborted(
	ctx: Pick<ExtensionContext, "hasUI" | "ui" | "signal">,
	message = "Cancelled",
): boolean {
	if (!ctx.signal?.aborted) {
		return false;
	}

	reportMessage(ctx, message, "info");
	return true;
}

export function formatChangesPreview(changes: string[], limit = 10): string {
	const preview = changes.slice(0, limit).join("\n");
	if (!preview) {
		return "";
	}
	const remainder = changes.length > limit ? `\n…and ${changes.length - limit} more` : "";
	return `${preview}${remainder}`;
}
