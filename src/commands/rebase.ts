import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { findWorktreeByBranch, inspectCurrentBranchFacts } from "../branch-facts.js";
import { evaluateRebaseReadiness, formatRebaseReadinessMessage, isReadyBranchFacts } from "../command-checks.js";
import { exec, inspectRepo, readWorktreeChanges, refreshWorktreeStateStatus, summarizeCommandOutput } from "../git.js";
import { cancelIfAborted } from "../shared.js";

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
	const facts = await inspectCurrentBranchFacts(pi, repo, { explicitBase, changeMode: "tracked" });
	const readiness = evaluateRebaseReadiness(facts);
	if (readiness.kind === "has-local-changes") {
		await refreshWorktreeStateStatus(pi, ctx);
		ctx.ui.notify(formatRebaseReadinessMessage(facts, readiness), "error");
		return;
	}
	if (readiness.kind !== "ready") {
		ctx.ui.notify(formatRebaseReadinessMessage(facts, readiness), "error");
		return;
	}

	if (!isReadyBranchFacts(facts)) {
		ctx.ui.notify("Could not determine the current branch state.", "error");
		return;
	}

	const readyFacts = facts;
	const baseBranchWorktree = findWorktreeByBranch(repo, readyFacts.baseBranch.name);
	const baseBranchWorktreeChanges = baseBranchWorktree ? await readWorktreeChanges(pi, baseBranchWorktree.path) : [];

	const confirmationLines = [
		`Current branch: ${readyFacts.branch}`,
		`Base branch: ${readyFacts.baseBranch.name}`,
		`Git ref: ${readyFacts.baseBranch.ref}`,
		`Source: ${readyFacts.baseBranch.source}`,
	];
	if (baseBranchWorktree) {
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
	if (cancelIfAborted(ctx)) {
		return;
	}

	ctx.ui.setStatus("pi-wt", `Rebasing ${readyFacts.branch} onto ${readyFacts.baseBranch.ref}...`);
	try {
		const result = await exec(pi, "git", ["rebase", readyFacts.baseBranch.ref], repo.cwd, { signal: ctx.signal });
		if (cancelIfAborted(ctx)) {
			return;
		}
		if (result.code === 0) {
			const output = summarizeCommandOutput(result);
			ctx.ui.notify(
				[`Rebased ${readyFacts.branch} onto ${readyFacts.baseBranch.name}.`, output ? `\n${output}` : ""]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
			return;
		}

		ctx.ui.notify(
			[
				`git rebase ${readyFacts.baseBranch.ref} failed.`,
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
