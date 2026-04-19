import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { inspectRepo } from "../git.js";
import { chooseSession, describeSession, listSessions, persistNewSessionHeader } from "../sessions.js";
import type { SessionSelectionMode } from "../types.js";
import {
	chooseWorkspaceTarget,
	createWorktreeFlow,
	getConfiguredSetupStep,
	getConfiguredWorktreeRoot,
	readProjectWorktreeTemplates,
	workspaceSummary,
} from "../worktrees.js";

export async function handleWorkspaceCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	sessionMode: SessionSelectionMode,
): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("/wt must be run inside a git repository", "error");
		return;
	}

	const menuChoice = await chooseWorkspaceTarget(ctx, repo, getConfiguredWorktreeRoot(pi));
	if (!menuChoice) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	const workspace =
		menuChoice.type === "workspace"
			? menuChoice.workspace
			: await createWorktreeFlow(
					pi,
					ctx,
					repo,
					getConfiguredWorktreeRoot(pi),
					getConfiguredSetupStep(pi, repo),
					readProjectWorktreeTemplates(repo),
				);
	if (!workspace) {
		return;
	}

	const sessions = await listSessions(workspace.cwd);
	if (sessionMode === "pick" && sessions.length > 0) {
		const selected = await chooseSession(ctx, workspace, sessions);
		if (!selected) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		await ctx.waitForIdle();
		const result = await ctx.switchSession(selected.path);
		if (!result.cancelled) {
			ctx.ui.notify(`Switched to ${workspaceSummary(workspace)} · ${describeSession(selected)}`, "info");
		}
		return;
	}

	if (sessionMode !== "new" && sessions.length > 0) {
		await ctx.waitForIdle();
		const result = await ctx.switchSession(sessions[0].path);
		if (!result.cancelled) {
			ctx.ui.notify(`Switched to ${workspaceSummary(workspace)} · ${describeSession(sessions[0])}`, "info");
		}
		return;
	}

	await ctx.waitForIdle();
	const sessionManager = SessionManager.create(workspace.cwd);
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		ctx.ui.notify("Failed to prepare session file", "error");
		return;
	}
	await persistNewSessionHeader(sessionManager, sessionFile);
	const result = await ctx.switchSession(sessionFile);
	if (!result.cancelled) {
		ctx.ui.notify(`Created new session in ${workspaceSummary(workspace)}`, "info");
	}
}
