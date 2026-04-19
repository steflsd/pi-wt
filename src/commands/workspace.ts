import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { inspectRepo } from "../git.js";
import { chooseSession, describeSession, listSessions, persistNewSessionHeader } from "../sessions.js";
import type { SessionSelectionMode, WorkspaceTarget } from "../types.js";
import {
	archiveWorktreeAtPathFlow,
	archiveWorktreeFlow,
	chooseWorkspaceTarget,
	createWorktreeFlow,
	getConfiguredSetupStep,
	getConfiguredWorktreeRoot,
	readProjectWorktreeSettings,
	workspaceSummary,
} from "../worktrees.js";

export async function handleWorkspaceCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	sessionMode: SessionSelectionMode,
): Promise<void> {
	const worktreeRoot = getConfiguredWorktreeRoot(pi);
	let workspace: WorkspaceTarget | undefined;
	while (!workspace) {
		const repo = await inspectRepo(pi, ctx.cwd);
		if (!repo) {
			ctx.ui.notify("/wt must be run inside a git repository", "error");
			return;
		}

		const settings = readProjectWorktreeSettings(repo);
		const menuChoice = await chooseWorkspaceTarget(ctx, repo, worktreeRoot);
		if (!menuChoice) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		if (menuChoice.type === "archive-worktree") {
			if (menuChoice.worktreePath) {
				await archiveWorktreeAtPathFlow(pi, ctx, repo, worktreeRoot, menuChoice.worktreePath);
			} else {
				await archiveWorktreeFlow(pi, ctx, repo, worktreeRoot);
			}
			continue;
		}

		workspace =
			menuChoice.type === "workspace"
				? menuChoice.workspace
				: await createWorktreeFlow(
						pi,
						ctx,
						repo,
						worktreeRoot,
						getConfiguredSetupStep(pi, repo),
						settings.templates,
						settings.branchPickerLimit,
					);
		if (!workspace) {
			return;
		}
	}

	const sessions = await listSessions(workspace.cwd);
	if (sessionMode !== "new" && sessions.length > 0) {
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
