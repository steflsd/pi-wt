import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getWtArgumentCompletions, parseWtCommand, wtUsageText } from "./command-spec.js";
import { handleEditorCommand, handleTerminalCommand } from "./commands/open.js";
import { handlePrCommand } from "./commands/pr.js";
import { handleRebaseCommand } from "./commands/rebase.js";
import { handleStatusCommand } from "./commands/status.js";
import { handleWorkspaceCommand } from "./commands/workspace.js";
import { refreshWorktreeStateStatus } from "./git.js";
import { toErrorMessage } from "./shared.js";
import { DEFAULT_WORKTREE_ROOT, WORKTREE_ROOT_FLAG, WT_SETUP_FLAG } from "./types.js";

export default function (pi: ExtensionAPI) {
	pi.registerFlag(WORKTREE_ROOT_FLAG, {
		description:
			"Base directory for new worktrees. Worktrees are created under <wt-root>/<repo-name>/<branch-name>; relative paths are resolved from the repo's main checkout.",
		type: "string",
		default: DEFAULT_WORKTREE_ROOT,
	});

	pi.registerFlag(WT_SETUP_FLAG, {
		description: "Optional shell command to run inside a newly created worktree before switching sessions.",
		type: "string",
		default: "",
	});

	pi.on("session_start", async (_event, ctx) => {
		await refreshWorktreeStateStatus(pi, ctx);
	});
	pi.on("turn_end", async (_event, ctx) => {
		await refreshWorktreeStateStatus(pi, ctx);
	});
	pi.on("user_bash", async (event, ctx) => {
		await refreshWorktreeStateStatus(pi, ctx, event.cwd);
	});

	pi.registerCommand("wt", {
		description: "Worktree helpers: switch/create worktrees, show status, rebase, and manage PRs",
		getArgumentCompletions: (prefix) => getWtArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			try {
				if (!ctx.hasUI) {
					throw new Error("/wt requires a UI-capable mode");
				}

				const command = parseWtCommand(args);
				switch (command.kind) {
					case "workspace":
						await handleWorkspaceCommand(pi, ctx, command.sessionMode);
						return;
					case "status":
						await handleStatusCommand(pi, ctx);
						return;
					case "rebase":
						await handleRebaseCommand(pi, ctx, command.explicitBase);
						return;
					case "pr":
						await handlePrCommand(pi, ctx, command.explicitBase);
						return;
					case "editor":
						await handleEditorCommand(pi, ctx);
						return;
					case "terminal":
						await handleTerminalCommand(pi, ctx);
						return;
					case "help":
						ctx.ui.notify(wtUsageText(), "info");
						return;
				}
			} catch (error) {
				const message = toErrorMessage(error);
				if (ctx.hasUI) {
					ctx.ui.notify(message, "error");
					return;
				}
				throw error instanceof Error ? error : new Error(message);
			}
		},
	});
}
