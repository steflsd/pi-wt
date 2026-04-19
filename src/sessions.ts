import { writeFile } from "node:fs/promises";
import { type ExtensionCommandContext, type SessionInfo, SessionManager } from "@mariozechner/pi-coding-agent";
import { safeRealpath } from "./shared.js";
import type { WorkspaceTarget } from "./types.js";

export async function persistNewSessionHeader(sessionManager: SessionManager, sessionFile: string): Promise<void> {
	const header = sessionManager.getHeader();
	if (!header) {
		throw new Error("Failed to initialize session header");
	}
	await writeFile(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
}

export async function listSessions(cwd: string): Promise<SessionInfo[]> {
	try {
		return (await SessionManager.list(cwd))
			.filter((session) => !session.cwd || safeRealpath(session.cwd) === safeRealpath(cwd))
			.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	} catch (error) {
		if (isMissingFileError(error)) {
			return [];
		}
		throw error;
	}
}

export async function chooseSession(
	ctx: ExtensionCommandContext,
	workspace: WorkspaceTarget,
	sessions: SessionInfo[],
): Promise<SessionInfo | undefined> {
	const labels = sessions.map((session) => `${describeSession(session)}\n  ${session.path}`);
	const byLabel = new Map(labels.map((label, index) => [label, sessions[index]]));
	const selected = await ctx.ui.select(`Sessions · ${workspaceSummary(workspace)}`, labels);
	return selected ? byLabel.get(selected) : undefined;
}

export function describeSession(session: SessionInfo): string {
	const label = session.name?.trim() || session.firstMessage?.trim() || session.id;
	const when = session.modified.toLocaleString();
	return `${truncate(label, 80)} · ${when}`;
}

function workspaceSummary(workspace: WorkspaceTarget): string {
	const prefix = workspace.kind === "current" ? "current" : workspace.kind === "main" ? "main" : "worktree";
	const branch = workspace.branch ?? workspace.cwd.split(/[\\/]/).pop() ?? workspace.cwd;
	return `${prefix} · ${branch}`;
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function isMissingFileError(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
	);
}
