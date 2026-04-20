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
