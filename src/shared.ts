import { realpathSync } from "node:fs";

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
