import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	detectBaseBranch,
	exec,
	formatPrState,
	hasGhCli,
	inspectRepo,
	readCurrentPr,
	summarizeCommandOutput,
} from "../git.js";

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
	if (existingPr) {
		ctx.ui.notify(
			[
				`PR #${existingPr.number}: ${existingPr.title}`,
				`State: ${formatPrState(existingPr)}`,
				`Base: ${existingPr.baseRefName}`,
				`Head: ${existingPr.headRefName}`,
				existingPr.url,
			].join("\n"),
			"info",
		);
		return;
	}

	const baseBranch = await detectBaseBranch(pi, repo, repo.cwd, repo.currentBranch, explicitBase);
	if (!baseBranch) {
		ctx.ui.notify("Could not determine a base branch. Try /wt pr <branch>", "error");
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Create PR",
		[
			`Head branch: ${repo.currentBranch}`,
			`Base branch: ${baseBranch.name}`,
			`Source: ${baseBranch.source}`,
			"Command: gh pr create --fill --base <base>",
		].join("\n"),
	);
	if (!confirmed) {
		ctx.ui.notify("Cancelled", "info");
		return;
	}

	await ctx.waitForIdle();
	ctx.ui.setStatus("pi-wt", `Creating PR for ${repo.currentBranch}...`);
	try {
		const result = await exec(pi, "gh", ["pr", "create", "--fill", "--base", baseBranch.name], repo.cwd);
		if (result.code === 0) {
			ctx.ui.notify(
				[`Created PR for ${repo.currentBranch} against ${baseBranch.name}.`, summarizeCommandOutput(result)]
					.filter(Boolean)
					.join("\n\n"),
				"info",
			);
			return;
		}

		ctx.ui.notify(
			[
				`gh pr create failed for ${repo.currentBranch}.`,
				summarizeCommandOutput(result) || "Check gh auth and repository settings.",
			].join("\n\n"),
			"error",
		);
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
	}
}
