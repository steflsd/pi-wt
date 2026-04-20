import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { commitAllChangesWithDraft } from "../commits.js";
import {
	detectBaseBranch,
	exec,
	formatPrState,
	hasGhCli,
	inspectRepo,
	planCurrentBranchPublish,
	readCurrentPr,
	readWorktreeChanges,
	summarizeCommandOutput,
} from "../git.js";
import { createPullRequest, generatePullRequestDraft, summarizeCreatePullRequestResult } from "../pull-requests.js";
import type { ExecResult, PullRequestDraft } from "../types.js";

export async function handlePrCommand(
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
		ctx.ui.notify("Cannot manage a PR from detached HEAD", "error");
		return;
	}

	if (!(await hasGhCli(pi, repo.cwd))) {
		ctx.ui.notify("gh CLI is required for /wt pr", "error");
		return;
	}

	const existingPr = await readCurrentPr(pi, repo.cwd);
	const baseBranch = await detectBaseBranch(
		pi,
		repo,
		repo.cwd,
		repo.currentBranch,
		existingPr ? undefined : explicitBase,
	);
	if (!baseBranch) {
		ctx.ui.notify("Could not determine a base branch. Try /wt pr <branch>", "error");
		return;
	}

	const localChanges = await readWorktreeChanges(pi, repo.cwd, true);
	if (localChanges.length > 0) {
		const shouldCommit = await ctx.ui.confirm(
			existingPr ? "Commit and update PR" : "Commit and create PR",
			`${repo.currentBranch} has local changes. ${existingPr ? "Updating this PR" : "Creating a PR"} requires a commit first.`,
		);
		if (!shouldCommit) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		const committed = await commitAllChangesWithDraft(pi, ctx, repo, repo.cwd, repo.currentBranch, baseBranch, {
			actionLabel: "Committing changes",
			promptTitle: `Commit message · ${repo.currentBranch}`,
		});
		if (!committed) {
			return;
		}
	}

	const publishPlan = await planCurrentBranchPublish(pi, repo.cwd, repo.currentBranch);
	if (publishPlan.needsPush && !publishPlan.commandArgs) {
		ctx.ui.notify(
			[
				existingPr
					? `Cannot update the PR for ${repo.currentBranch} because the branch is not published.`
					: `Cannot create a PR for ${repo.currentBranch} because the branch is not published.`,
				publishPlan.reason ?? "Push the branch manually or configure a default push remote.",
			].join("\n\n"),
			"error",
		);
		return;
	}

	await ctx.waitForIdle();
	try {
		if (publishPlan.commandArgs) {
			ctx.ui.setStatus("pi-wt", `Publishing ${repo.currentBranch}...`);
			const pushResult = await exec(pi, "git", publishPlan.commandArgs, repo.cwd);
			if (pushResult.code !== 0) {
				ctx.ui.notify(
					[
						existingPr
							? `Failed to publish ${repo.currentBranch} before updating its PR.`
							: `Failed to publish ${repo.currentBranch} before creating a PR.`,
						summarizeCommandOutput(pushResult) || "Check git remote configuration and try again.",
					].join("\n\n"),
					"error",
				);
				return;
			}
		}

		if (existingPr) {
			ctx.ui.notify(
				[
					publishPlan.commandArgs
						? `Updated PR #${existingPr.number}: ${existingPr.title}`
						: `PR #${existingPr.number}: ${existingPr.title}`,
					`State: ${formatPrState(existingPr)}`,
					`Base: ${existingPr.baseRefName}`,
					`Head: ${existingPr.headRefName}`,
					formatPrLink(existingPr.url),
				].join("\n"),
				"info",
			);
			return;
		}

		let draft: PullRequestDraft | null = null;
		try {
			ctx.ui.setStatus("pi-wt", `Drafting PR for ${repo.currentBranch}...`);
			draft = await generatePullRequestDraft(pi, ctx, repo, baseBranch);
		} catch {
			draft = null;
		}

		ctx.ui.setStatus("pi-wt", `Creating PR for ${repo.currentBranch}...`);
		const created = await createPullRequest(pi, repo.cwd, baseBranch.name, draft);
		if (created.result.code === 0) {
			ctx.ui.notify(
				[
					`Created PR for ${repo.currentBranch} against ${baseBranch.name}.`,
					draft && created.mode === "generated" ? `Prompt: ${draft.promptPath}` : null,
					created.mode === "fill" && ctx.model ? "Fell back to gh --fill." : null,
					formatPrCommandOutput(created.result),
				]
					.filter(Boolean)
					.join("\n\n"),
				"info",
			);
			return;
		}

		ctx.ui.notify(
			[
				`gh pr create failed for ${repo.currentBranch}.`,
				draft ? `Prompt: ${draft.promptPath}` : null,
				summarizeCreatePullRequestResult(created.result) || "Check gh auth and repository settings.",
			]
				.filter(Boolean)
				.join("\n\n"),
			"error",
		);
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
	}
}

function formatPrCommandOutput(result: ExecResult): string {
	const output = summarizeCreatePullRequestResult(result);
	if (!output) {
		return "";
	}

	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 1 && /^https?:\/\//.test(lines[0])) {
		return formatPrLink(lines[0]);
	}
	return output;
}

function formatPrLink(url: string): string {
	return `Open in GitHub: ${url}`;
}
