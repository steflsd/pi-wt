import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { inspectCurrentBranchFacts } from "../branch-facts.js";
import { evaluatePrReadiness, formatPrReadinessMessage, isReadyBranchFacts } from "../command-checks.js";
import { commitAllChangesWithDraft } from "../commits.js";
import {
	exec,
	formatPrState,
	hasGhCli,
	inspectRepo,
	planCurrentBranchPublish,
	readCurrentPr,
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
	if (!(await hasGhCli(pi, repo.cwd))) {
		ctx.ui.notify("gh CLI is required for /wt pr", "error");
		return;
	}

	const existingPr = await readCurrentPr(pi, repo.cwd);
	const facts = await inspectCurrentBranchFacts(pi, repo, {
		explicitBase: existingPr ? undefined : explicitBase,
		pullRequest: existingPr,
		changeMode: "all",
	});
	const readiness = evaluatePrReadiness(facts);
	if (readiness.kind !== "ready" && readiness.kind !== "needs-commit") {
		ctx.ui.notify(formatPrReadinessMessage(readiness), "error");
		return;
	}

	if (!isReadyBranchFacts(facts)) {
		ctx.ui.notify("Could not determine the current branch state.", "error");
		return;
	}

	const readyFacts = facts;
	if (readiness.kind === "needs-commit") {
		const shouldCommit = await ctx.ui.confirm(
			existingPr ? "Commit and update PR" : "Commit and create PR",
			`${readyFacts.branch} has local changes. ${existingPr ? "Updating this PR" : "Creating a PR"} requires a commit first.`,
		);
		if (!shouldCommit) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		const committed = await commitAllChangesWithDraft(
			pi,
			ctx,
			repo,
			repo.cwd,
			readyFacts.branch,
			readyFacts.baseBranch,
			{
				actionLabel: "Committing changes",
				promptTitle: `Commit message · ${readyFacts.branch}`,
			},
		);
		if (!committed) {
			return;
		}
	}

	const publishPlan = await planCurrentBranchPublish(pi, repo.cwd, readyFacts.branch);
	if (publishPlan.needsPush && !publishPlan.commandArgs) {
		ctx.ui.notify(
			[
				existingPr
					? `Cannot update the PR for ${readyFacts.branch} because the branch is not published.`
					: `Cannot create a PR for ${readyFacts.branch} because the branch is not published.`,
				publishPlan.reason ?? "Push the branch manually or configure a default push remote.",
			].join("\n\n"),
			"error",
		);
		return;
	}

	await ctx.waitForIdle();
	try {
		if (publishPlan.commandArgs) {
			ctx.ui.setStatus("pi-wt", `Publishing ${readyFacts.branch}...`);
			const pushResult = await exec(pi, "git", publishPlan.commandArgs, repo.cwd);
			if (pushResult.code !== 0) {
				ctx.ui.notify(
					[
						existingPr
							? `Failed to publish ${readyFacts.branch} before updating its PR.`
							: `Failed to publish ${readyFacts.branch} before creating a PR.`,
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
			ctx.ui.setStatus("pi-wt", `Drafting PR for ${readyFacts.branch}...`);
			draft = await generatePullRequestDraft(pi, ctx, repo, readyFacts.baseBranch);
		} catch {
			draft = null;
		}

		ctx.ui.setStatus("pi-wt", `Creating PR for ${readyFacts.branch}...`);
		const created = await createPullRequest(pi, repo.cwd, readyFacts.baseBranch.name, draft);
		if (created.result.code === 0) {
			ctx.ui.notify(
				[
					`Created PR for ${readyFacts.branch} against ${readyFacts.baseBranch.name}.`,
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
				`gh pr create failed for ${readyFacts.branch}.`,
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
