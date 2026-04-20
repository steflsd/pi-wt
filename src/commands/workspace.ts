import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { inspectRepo } from "../git.js";
import {
	chooseSession,
	cloneCurrentSessionToWorkspace,
	describeSession,
	listSessions,
	persistNewSessionHeader,
} from "../sessions.js";
import type { RepoState, WorkspaceTarget } from "../types.js";
import {
	archiveWorktreeAtPathFlow,
	chooseWorkspaceTarget,
	createWorktreeFlow,
	getConfiguredSetupStep,
	getConfiguredWorktreeRoot,
	readProjectWorktreeSettings,
	workspaceSummary,
} from "../worktrees.js";
import { launchWorktreeInNewTab } from "./open.js";

export async function handleWorkspaceCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
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
			const currentWorktreePath = repo.worktrees.find((worktree) => worktree.isCurrent)?.path;
			const archivingCurrentWorktree = menuChoice.worktreePath === currentWorktreePath;
			if (menuChoice.worktreePath) {
				await archiveWorktreeAtPathFlow(pi, ctx, repo, worktreeRoot, menuChoice.worktreePath);
			}
			if (archivingCurrentWorktree) {
				return;
			}
			continue;
		}

		if (menuChoice.type === "workspace") {
			workspace = menuChoice.workspace;
		} else {
			const created = await createWorktreeFlow(
				pi,
				ctx,
				repo,
				worktreeRoot,
				getConfiguredSetupStep(pi, repo),
				settings.templates,
				settings.branchPickerLimit,
			);
			if (!created) {
				return;
			}

			const shouldContinueSessionInNewTerminal = shouldContinueSessionForNewWorktree(ctx, repo);
			if (shouldContinueSessionInNewTerminal) {
				const sessionPath = await cloneCurrentSessionToWorkspace(ctx, created);
				await launchWorktreeInNewTab(pi, ctx, repo, created.cwd, { sessionPath });
				return;
			}

			await launchWorktreeInNewTab(pi, ctx, repo, created.cwd);
			return;
		}
	}

	const sessions = await listSessions(workspace.cwd);
	if (sessions.length > 0) {
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

function shouldContinueSessionForNewWorktree(ctx: ExtensionCommandContext, repo: RepoState): boolean {
	const hasSessionHistory = ctx.sessionManager.getEntries().length > 0;
	const currentWorktree = repo.worktrees.find((worktree) => worktree.isCurrent);
	const isStartingFromMain =
		currentWorktree?.isMainCheckout === true ||
		(repo.currentBranch !== null && repo.defaultBranch !== null && repo.currentBranch === repo.defaultBranch);
	return hasSessionHistory && isStartingFromMain;
}
