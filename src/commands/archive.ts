import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { inspectRepo } from "../git.js";
import { archiveWorktreeFlow, getConfiguredWorktreeRoot } from "../worktrees.js";

export async function handleArchiveCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("/wt must be run inside a git repository", "error");
		return;
	}

	await archiveWorktreeFlow(pi, ctx, repo, getConfiguredWorktreeRoot(pi));
}
