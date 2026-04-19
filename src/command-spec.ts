import type { WtCommand } from "./types.js";

export function getWtArgumentCompletions(prefix: string) {
	const trimmed = prefix.trimStart();
	if (trimmed.includes(" ")) return null;

	const items = [
		{ value: "new", label: "create a fresh session in the selected workspace" },
		{ value: "status", label: "show current worktree, branch, base branch, and PR info" },
		{
			value: "rebase",
			label: "update the current branch by rebasing onto its detected base branch; requires a clean working tree",
		},
		{ value: "pr", label: "view or create a PR for the current branch" },
		{ value: "archive", label: "remove a linked worktree and delete its local branch when safely merged" },
		{ value: "editor", label: "open the current worktree in your configured editor" },
		{ value: "term", label: "open the current worktree in your configured terminal" },
		{ value: "help", label: "show /wt usage" },
	];

	const filtered = items.filter((item) => item.value.startsWith(trimmed));
	return filtered.length > 0 ? filtered : null;
}

export function parseWtCommand(args: string): WtCommand {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "workspace", sessionMode: "auto" };

	const [subcommand, ...rest] = trimmed.split(/\s+/);
	const normalized = subcommand.toLowerCase();
	const trailing = rest.join(" ").trim();

	if (["new", "fresh"].includes(normalized)) {
		if (trailing) throw new Error("Usage: /wt new");
		return { kind: "workspace", sessionMode: "new" };
	}

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

	if (normalized === "archive") {
		if (trailing) throw new Error("Usage: /wt archive");
		return { kind: "archive" };
	}

	if (normalized === "editor") {
		if (trailing) throw new Error("Usage: /wt editor");
		return { kind: "editor" };
	}

	if (normalized === "term") {
		if (trailing) throw new Error("Usage: /wt term");
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
		"/wt new           Create a fresh session in the selected workspace",
		"/wt status        Show current branch, base branch, and PR info",
		"/wt rebase [base] Update current branch by rebasing onto detected or explicit base branch; requires a clean working tree",
		"/wt pr [base]     View current PR, or create one against detected or explicit base branch",
		"/wt archive       Remove a linked worktree and delete its local branch when safely merged",
		"/wt editor        Open the current worktree in your configured editor",
		"/wt term          Open the current worktree in your configured terminal",
	].join("\n");
}
