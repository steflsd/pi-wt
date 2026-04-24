import { writeFile } from "node:fs/promises";
import type { SessionHeader } from "@mariozechner/pi-coding-agent";
import { type ExtensionCommandContext, type SessionInfo, SessionManager } from "@mariozechner/pi-coding-agent";
import { safeRealpath } from "./shared.js";
import type { WorkspaceTarget } from "./types.js";

type SwitchSessionOptions = Parameters<ExtensionCommandContext["switchSession"]>[1];

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

export async function switchToLatestOrCreateSession(
	ctx: ExtensionCommandContext,
	workspace: WorkspaceTarget,
	options?: SwitchSessionOptions,
): Promise<{ cancelled: boolean; session?: SessionInfo; created: boolean }> {
	const sessions = await listSessions(workspace.cwd);
	if (sessions.length > 0) {
		await ctx.waitForIdle();
		const result = await ctx.switchSession(sessions[0].path, { withSession: options?.withSession });
		return { cancelled: result.cancelled, session: sessions[0], created: false };
	}

	await ctx.waitForIdle();
	const sessionManager = SessionManager.create(workspace.cwd);
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		throw new Error(`Failed to prepare session file for ${workspace.cwd}`);
	}
	await persistNewSessionHeader(sessionManager, sessionFile);
	const result = await ctx.switchSession(sessionFile, { withSession: options?.withSession });
	return { cancelled: result.cancelled, created: true };
}

export async function cloneCurrentSessionToWorkspace(
	ctx: ExtensionCommandContext,
	workspace: WorkspaceTarget,
): Promise<string> {
	const targetSessionManager = SessionManager.create(workspace.cwd);
	const targetSessionFile = targetSessionManager.getSessionFile();
	const targetHeader = targetSessionManager.getHeader();
	if (!targetSessionFile || !targetHeader) {
		throw new Error(`Failed to prepare session file for ${workspace.cwd}`);
	}

	const sourceSessionFile = ctx.sessionManager.getSessionFile();
	const header: SessionHeader = sourceSessionFile
		? { ...targetHeader, parentSession: sourceSessionFile }
		: targetHeader;
	const content = [
		JSON.stringify(header),
		...ctx.sessionManager.getEntries().map((entry) => JSON.stringify(entry)),
	].join("\n");
	await writeFile(targetSessionFile, `${content}\n`, "utf8");
	return targetSessionFile;
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
