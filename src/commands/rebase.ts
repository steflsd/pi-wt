import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	detectBaseBranch,
	exec,
	inspectRepo,
	normalizeBranchName,
	readTrackedWorktreeChanges,
	readWorktreeChanges,
	refreshWorktreeStateStatus,
	summarizeCommandOutput,
} from "../git.js";

export async function handleRebaseCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	explicitBase?: string,
): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("/wt must be run inside a git repository", "error");
		return;
	}
	if (!repo.currentBranch) {
		ctx.ui.notify("Cannot rebase from detached HEAD", "error");
		return;
	}

	const baseBranch = await detectBaseBranch(pi, repo, repo.cwd, repo.currentBranch, explicitBase);
	if (!baseBranch) {
		ctx.ui.notify("Could not determine a base branch. Try /wt rebase <branch>", "error");
		return;
	}
	if (normalizeBranchName(baseBranch.name) === normalizeBranchName(repo.currentBranch)) {
		ctx.ui.notify(`Refusing to rebase ${repo.currentBranch} onto itself`, "error");
		return;
	}

	const trackedChanges = await readTrackedWorktreeChanges(pi, repo.cwd);
	if (trackedChanges.length > 0) {
		await refreshWorktreeStateStatus(pi, ctx);
		const preview = trackedChanges.slice(0, 10).join("\n");
		const remainder = trackedChanges.length > 10 ? `\n…and ${trackedChanges.length - 10} more` : "";
		ctx.ui.notify(
			[
				"Cannot rebase: a clean working tree is required.",
				"This worktree has tracked local changes.",
				"Commit, stash, or discard them first.",
				preview ? `\n${preview}${remainder}` : "",
			]
				.filter(Boolean)
				.join("\n"),
			"error",
		);
		return;
	}

	const baseBranchInfo = repo.branches.find((branch) => branch.name === normalizeBranchName(baseBranch.name));
	const baseBranchWorktreeChanges = baseBranchInfo?.worktreePath
		? await readWorktreeChanges(pi, baseBranchInfo.worktreePath)
		: [];

	const confirmationLines = [
		`Current branch: ${repo.currentBranch}`,
		`Base branch: ${baseBranch.name}`,
		`Git ref: ${baseBranch.ref}`,
		`Source: ${baseBranch.source}`,
	];
	if (baseBranchInfo?.worktreePath) {
		confirmationLines.push(
			baseBranchWorktreeChanges.length > 0
				? `Base worktree: dirty (${baseBranchWorktreeChanges.length} local changes; does not block rebase)`
				: "Base worktree: clean",
		);
	}

	const confirmed = await ctx.ui.confirm("Rebase current branch", confirmationLines.join("\n"));
	if (!confirmed) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	await ctx.waitForIdle();
	ctx.ui.setStatus("pi-wt", `Rebasing ${repo.currentBranch} onto ${baseBranch.ref}...`);
	try {
		const result = await exec(pi, "git", ["rebase", baseBranch.ref], repo.cwd);
		if (result.code === 0) {
			const output = summarizeCommandOutput(result);
			ctx.ui.notify(
				[`Rebased ${repo.currentBranch} onto ${baseBranch.name}.`, output ? `\n${output}` : ""]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
			return;
		}

		ctx.ui.notify(
			[
				`git rebase ${baseBranch.ref} failed.`,
				summarizeCommandOutput(result) ||
					"Resolve conflicts, then run git rebase --continue or git rebase --abort.",
			].join("\n\n"),
			"error",
		);
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
		await refreshWorktreeStateStatus(pi, ctx);
	}
}
