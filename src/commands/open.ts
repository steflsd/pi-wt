import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { execShell, inspectRepo } from "../git.js";
import type { RepoState } from "../types.js";
import { readProjectWorktreeSettings } from "../worktrees.js";

type OpenTarget = "editor" | "terminal";

interface CommandCandidate {
	probe?: string;
	command: string;
}

interface LaunchCommandCandidate {
	probe?: string;
	command: string;
}

export async function handleEditorCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("/wt editor must be run inside a git repository", "error");
		return;
	}
	await openWorkspaceTarget(pi, ctx, repo, repo.cwd, "editor");
}

export async function handleTerminalCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("/wt term must be run inside a git repository", "error");
		return;
	}
	await openWorkspaceTarget(pi, ctx, repo, repo.cwd, "terminal");
}

export async function openWorkspaceTarget(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	cwd: string,
	target: OpenTarget,
): Promise<boolean> {
	const settings = readProjectWorktreeSettings(repo);
	const configuredCommand = target === "editor" ? settings.editorCommand : settings.terminalCommand;
	const command = configuredCommand
		? renderOpenCommand(configuredCommand, cwd)
		: await resolveFallbackOpenCommand(pi, target, cwd);
	if (!command) {
		ctx.ui.notify(
			[
				`Could not determine a ${target} command for this machine.`,
				`Configure wt.${target}Command in .pi/settings.json.`,
				`Example: { "wt": { "${target}Command": "${exampleCommand(target)}" } }`,
			].join("\n"),
			"error",
		);
		return false;
	}

	ctx.ui.setStatus("pi-wt", `Opening ${target} for ${cwd}...`);
	try {
		const result = await execShell(pi, command, cwd);
		if (result.code !== 0) {
			ctx.ui.notify(
				[
					`Failed to open ${target}.`,
					result.stderr.trim() || result.stdout.trim() || `Command exited with code ${result.code}.`,
				].join("\n\n"),
				"error",
			);
			return false;
		}

		ctx.ui.notify(`Opened worktree in ${target}.`, "info");
		return true;
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
	}
}

export async function launchWorktreeInNewTab(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	cwd: string,
): Promise<boolean> {
	const settings = readProjectWorktreeSettings(repo);
	const command = settings.newWorktreeTabCommand?.trim()
		? renderLaunchCommand(settings.newWorktreeTabCommand, cwd, "pi")
		: await resolveTerminalLaunchCommand(pi, cwd, "pi");
	if (!command) {
		ctx.ui.notify(
			[
				"Could not determine how to open a new tab for a new worktree and start pi.",
				"Configure wt.newWorktreeTabCommand in .pi/settings.json.",
				'Example: { "wt": { "newWorktreeTabCommand": "wezterm start --cwd {{path}} pi" } }',
			].join("\n"),
			"error",
		);
		return false;
	}

	ctx.ui.setStatus("pi-wt", `Opening new tab for ${cwd}...`);
	try {
		const result = await execShell(pi, command, cwd);
		if (result.code !== 0) {
			ctx.ui.notify(
				[
					"Failed to open a new tab for the new worktree.",
					result.stderr.trim() || result.stdout.trim() || `Command exited with code ${result.code}.`,
				].join("\n\n"),
				"error",
			);
			return false;
		}

		ctx.ui.notify("Opened new worktree in a new tab and started pi.", "info");
		return true;
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
	}
}

function renderOpenCommand(template: string, cwd: string): string {
	const quotedPath = quoteShellArg(cwd);
	const rendered = template.replaceAll("{{path}}", quotedPath);
	return rendered === template ? `${template} ${quotedPath}` : rendered;
}

function renderLaunchCommand(template: string, cwd: string, command: string): string {
	const quotedPath = quoteShellArg(cwd);
	const quotedCommand = command;
	let rendered = template.replaceAll("{{path}}", quotedPath).replaceAll("{{command}}", quotedCommand);
	if (rendered === template) {
		rendered = `${template} ${quotedPath} ${quotedCommand}`;
	} else if (!template.includes("{{command}}")) {
		rendered = `${rendered} ${quotedCommand}`;
	}
	return rendered;
}

async function resolveFallbackOpenCommand(pi: ExtensionAPI, target: OpenTarget, cwd: string): Promise<string | null> {
	if (target === "editor") {
		const preferredEditor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
		if (preferredEditor) {
			return renderOpenCommand(preferredEditor, cwd);
		}
	}

	const termProgramCandidate = getTermProgramCandidate(target, process.platform, process.env.TERM_PROGRAM);
	if (
		termProgramCandidate &&
		(!termProgramCandidate.probe || (await commandExists(pi, termProgramCandidate.probe, cwd)))
	) {
		return renderOpenCommand(termProgramCandidate.command, cwd);
	}

	const candidates = getFallbackCandidates(target, process.platform);
	for (const candidate of candidates) {
		if (!candidate.probe || (await commandExists(pi, candidate.probe, cwd))) {
			return renderOpenCommand(candidate.command, cwd);
		}
	}

	return null;
}

async function resolveTerminalLaunchCommand(
	pi: ExtensionAPI,
	cwd: string,
	launchCommand: string,
): Promise<string | null> {
	const termProgramCandidate = getTerminalLaunchTermProgramCandidate(
		process.platform,
		process.env.TERM_PROGRAM,
		cwd,
		launchCommand,
	);
	if (
		termProgramCandidate &&
		(!termProgramCandidate.probe || (await commandExists(pi, termProgramCandidate.probe, cwd)))
	) {
		return termProgramCandidate.command;
	}

	const candidates = getTerminalLaunchFallbackCandidates(process.platform, cwd, launchCommand);
	for (const candidate of candidates) {
		if (!candidate.probe || (await commandExists(pi, candidate.probe, cwd))) {
			return candidate.command;
		}
	}

	return null;
}

function getTermProgramCandidate(
	target: OpenTarget,
	platform: NodeJS.Platform,
	termProgram: string | undefined,
): CommandCandidate | null {
	if (target !== "terminal" || platform !== "darwin") {
		return null;
	}

	const normalizedTermProgram = termProgram?.trim().toLowerCase();
	if (!normalizedTermProgram) {
		return null;
	}

	if (normalizedTermProgram === "apple_terminal") {
		return { probe: "open", command: "open -a Terminal {{path}}" };
	}
	if (normalizedTermProgram === "iterm.app") {
		return { probe: "open", command: "open -a iTerm {{path}}" };
	}
	if (normalizedTermProgram === "ghostty") {
		return { probe: "open", command: "open -a Ghostty {{path}}" };
	}
	if (normalizedTermProgram === "wezterm") {
		return { probe: "wezterm", command: "wezterm start --cwd {{path}}" };
	}
	if (normalizedTermProgram === "warpterminal") {
		return { probe: "open", command: "open -a Warp {{path}}" };
	}

	return null;
}

function getTerminalLaunchTermProgramCandidate(
	platform: NodeJS.Platform,
	termProgram: string | undefined,
	cwd: string,
	launchCommand: string,
): LaunchCommandCandidate | null {
	if (platform !== "darwin") {
		return null;
	}

	const normalizedTermProgram = termProgram?.trim().toLowerCase();
	if (!normalizedTermProgram) {
		return null;
	}

	if (normalizedTermProgram === "ghostty") {
		return {
			probe: "open",
			command: `open -a Ghostty --args --working-directory=${quoteShellArg(cwd)} -e ${launchCommand}`,
		};
	}
	if (normalizedTermProgram === "wezterm") {
		return { probe: "wezterm", command: `wezterm start --cwd ${quoteShellArg(cwd)} ${launchCommand}` };
	}

	return null;
}

function getFallbackCandidates(target: OpenTarget, platform: NodeJS.Platform): CommandCandidate[] {
	if (target === "editor") {
		if (platform === "darwin") {
			return [
				{ probe: "cursor", command: "cursor {{path}}" },
				{ probe: "code", command: "code {{path}}" },
				{ probe: "zed", command: "zed {{path}}" },
				{ probe: "subl", command: "subl {{path}}" },
			];
		}
		if (platform === "win32") {
			return [
				{ probe: "cursor", command: "cursor {{path}}" },
				{ probe: "code", command: "code {{path}}" },
				{ probe: "notepad", command: "notepad {{path}}" },
			];
		}
		return [
			{ probe: "cursor", command: "cursor {{path}}" },
			{ probe: "code", command: "code {{path}}" },
			{ probe: "zed", command: "zed {{path}}" },
			{ probe: "subl", command: "subl {{path}}" },
		];
	}

	if (platform === "darwin") {
		return [{ probe: "open", command: "open -a Terminal {{path}}" }];
	}
	if (platform === "win32") {
		return [{ probe: "wt", command: "wt -d {{path}}" }];
	}
	return [
		{ probe: "x-terminal-emulator", command: "x-terminal-emulator --working-directory={{path}}" },
		{ probe: "gnome-terminal", command: "gnome-terminal --working-directory={{path}}" },
		{ probe: "kitty", command: "kitty --directory {{path}}" },
		{ probe: "konsole", command: "konsole --workdir {{path}}" },
		{ probe: "wezterm", command: "wezterm start --cwd {{path}}" },
		{ probe: "xfce4-terminal", command: "xfce4-terminal --working-directory={{path}}" },
		{ probe: "alacritty", command: "alacritty --working-directory {{path}}" },
	];
}

function getTerminalLaunchFallbackCandidates(
	platform: NodeJS.Platform,
	cwd: string,
	launchCommand: string,
): LaunchCommandCandidate[] {
	if (platform === "darwin") {
		return [
			{
				probe: "open",
				command: `open -a Ghostty --args --working-directory=${quoteShellArg(cwd)} -e ${launchCommand}`,
			},
			{ probe: "wezterm", command: `wezterm start --cwd ${quoteShellArg(cwd)} ${launchCommand}` },
		];
	}
	if (platform === "win32") {
		return [{ probe: "wt", command: `wt -d ${quoteShellArg(cwd)} ${launchCommand}` }];
	}
	return [
		{ probe: "wezterm", command: `wezterm start --cwd ${quoteShellArg(cwd)} ${launchCommand}` },
		{ probe: "kitty", command: `kitty --directory ${quoteShellArg(cwd)} ${launchCommand}` },
		{
			probe: "gnome-terminal",
			command: `gnome-terminal --working-directory=${quoteShellArg(cwd)} -- ${launchCommand}`,
		},
		{ probe: "konsole", command: `konsole --workdir ${quoteShellArg(cwd)} -e ${launchCommand}` },
		{
			probe: "xfce4-terminal",
			command: `xfce4-terminal --working-directory=${quoteShellArg(cwd)} --command=${quoteShellArg(launchCommand)}`,
		},
		{ probe: "alacritty", command: `alacritty --working-directory ${quoteShellArg(cwd)} -e ${launchCommand}` },
	];
}

async function commandExists(pi: ExtensionAPI, command: string, cwd: string): Promise<boolean> {
	const result = await execShell(pi, `command -v ${quoteShellArg(command)} >/dev/null 2>&1`, cwd);
	return result.code === 0;
}

function exampleCommand(target: OpenTarget): string {
	if (target === "editor") {
		return "cursor {{path}}";
	}
	return process.platform === "darwin" ? "open -a Terminal {{path}}" : "kitty --directory {{path}}";
}

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
