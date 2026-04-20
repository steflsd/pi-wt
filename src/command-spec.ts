import type { WtCommand } from "./types.js";

export function getWtArgumentCompletions(prefix: string) {
	const trimmed = prefix.trimStart();
	if (trimmed.includes(" ")) return null;

	const items = [
		{ value: "status", label: "show current worktree, branch, base branch, and PR info" },
		{
			value: "rebase",
			label: "update the current branch by rebasing onto its detected base branch; requires a clean working tree",
		},
		{ value: "pr", label: "view or create a PR for the current branch" },
		{ value: "editor", label: "open the current worktree in your configured editor (alias: edit)" },
		{ value: "terminal", label: "open the current worktree in your configured terminal (alias: term)" },
		{ value: "help", label: "show /wt usage" },
	];

	const filtered = items.filter((item) => item.value.startsWith(trimmed));
	return filtered.length > 0 ? filtered : null;
}

export function parseWtCommand(args: string): WtCommand {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "workspace" };

	const [subcommand, ...rest] = trimmed.split(/\s+/);
	const normalized = subcommand.toLowerCase();
	const trailing = rest.join(" ").trim();

	if (normalized === "status") {
		if (trailing) throw new Error("Usage: /wt status");
		return { kind: "status" };
	}

	if (normalized === "rebase") {
		return { kind: "rebase", explicitBase: trailing || undefined };
	}

	if (normalized === "pr") {
		return { kind: "pr", explicitBase: trailing || undefined };
	}

	if (normalized === "editor" || normalized === "edit") {
		if (trailing) throw new Error("Usage: /wt editor");
		return { kind: "editor" };
	}

	if (normalized === "terminal" || normalized === "term") {
		if (trailing) throw new Error("Usage: /wt terminal");
		return { kind: "terminal" };
	}

	if (normalized === "help") {
		return { kind: "help" };
	}

	throw new Error(wtUsageText());
}

export function wtUsageText(): string {
	return [
		"Usage:",
		"/wt               Open the worktree list and choose a session, or create one if none exists",
		"/wt status        Show current branch, base branch, and PR info",
		"/wt rebase [base] Update current branch by rebasing onto detected or explicit base branch; requires a clean working tree",
		"/wt pr [base]     View current PR, or create one against detected or explicit base branch",
		"/wt editor        Open the current worktree in your configured editor (alias: /wt edit)",
		"/wt terminal      Open the current worktree in your configured terminal (alias: /wt term)",
	].join("\n");
}
