import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildWorktreeSystemPromptContext } from "./branch-facts.js";
import { getWtArgumentCompletions, parseWtCommand, wtUsageText } from "./command-spec.js";
import { handleLandCommand } from "./commands/land.js";
import { handleEditorCommand, handleTerminalCommand } from "./commands/open.js";
import { handlePrCommand } from "./commands/pr.js";
import { handleRebaseCommand } from "./commands/rebase.js";
import { handleStatusCommand } from "./commands/status.js";
import { handleWorkspaceCommand } from "./commands/workspace.js";
import { refreshWorktreeStateStatus } from "./git.js";
import { reportMessage, toErrorMessage } from "./shared.js";
import { DEFAULT_WORKTREE_ROOT, WORKTREE_ROOT_FLAG, WT_SETUP_FLAG, WT_STATE_STATUS_KEY } from "./types.js";

const WORKTREE_STATE_POLL_INTERVAL_MS = 5000;

export default function (pi: ExtensionAPI) {
	let worktreeStatePollTimer: ReturnType<typeof setInterval> | undefined;
	let worktreeStateRefreshInFlight = false;

	const stopWorktreeStatePolling = () => {
		if (!worktreeStatePollTimer) return;
		clearInterval(worktreeStatePollTimer);
		worktreeStatePollTimer = undefined;
	};

	const refreshWorktreeState = async (ctx: ExtensionContext, cwd?: string) => {
		if (worktreeStateRefreshInFlight) return;
		worktreeStateRefreshInFlight = true;
		try {
			await refreshWorktreeStateStatus(pi, ctx, cwd);
		} finally {
			worktreeStateRefreshInFlight = false;
		}
	};

	const startWorktreeStatePolling = (ctx: ExtensionContext) => {
		stopWorktreeStatePolling();
		if (!ctx.hasUI) return;
		worktreeStatePollTimer = setInterval(() => {
			void refreshWorktreeState(ctx).catch((error) => {
				ctx.ui.setStatus(WT_STATE_STATUS_KEY, undefined);
				console.error(`[pi-wt] Failed to refresh worktree state: ${toErrorMessage(error)}`);
			});
		}, WORKTREE_STATE_POLL_INTERVAL_MS);
	};
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
		await refreshWorktreeState(ctx);
		startWorktreeStatePolling(ctx);
	});
	pi.on("session_shutdown", async () => {
		stopWorktreeStatePolling();
	});
	pi.on("turn_end", async (_event, ctx) => {
		await refreshWorktreeState(ctx);
	});
	pi.on("user_bash", async (event, ctx) => {
		await refreshWorktreeState(ctx, event.cwd);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		const worktreeContext = await buildWorktreeSystemPromptContext(
			pi,
			event.systemPromptOptions?.cwd ?? ctx.cwd,
			event.prompt,
		);
		if (!worktreeContext) {
			return undefined;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${worktreeContext}`,
		};
	});

	pi.registerCommand("wt", {
		description: "Worktree helpers: switch/create worktrees, show status, land, rebase, and manage PRs",
		getArgumentCompletions: (prefix) => getWtArgumentCompletions(prefix),
		handler: async (args, ctx) => {
			try {
				const command = parseWtCommand(args);
				if (!ctx.hasUI && ["workspace", "land", "rebase", "pr"].includes(command.kind)) {
					const commandLabel = command.kind === "workspace" ? "/wt" : `/wt ${command.kind}`;
					throw new Error(`${commandLabel} requires a UI-capable mode`);
				}

				switch (command.kind) {
					case "workspace":
						await handleWorkspaceCommand(pi, ctx);
						return;
					case "status":
						await handleStatusCommand(pi, ctx);
						return;
					case "land":
						await handleLandCommand(pi, ctx);
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
						reportMessage(ctx, wtUsageText(), "info");
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
