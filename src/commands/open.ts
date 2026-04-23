import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { execShell, inspectRepo } from "../git.js";
import { reportMessage } from "../shared.js";
import type { ExecResult, RepoState } from "../types.js";
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
		reportMessage(ctx, "/wt editor must be run inside a git repository", "error");
		return;
	}
	await openWorkspaceTarget(pi, ctx, repo, currentWorkspaceRoot(repo), "editor");
}

export async function handleTerminalCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		reportMessage(ctx, "/wt terminal must be run inside a git repository", "error");
		return;
	}
	await openWorkspaceTarget(pi, ctx, repo, currentWorkspaceRoot(repo), "terminal");
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
	const commands = configuredCommand
		? [renderOpenCommand(configuredCommand, cwd)]
		: resolveFallbackOpenCommands(target, cwd);
	if (commands.length === 0) {
		reportMessage(
			ctx,
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
		const result = await tryCommands(pi, cwd, commands);
		if (!result || result.code !== 0) {
			reportMessage(
				ctx,
				[
					`Failed to open ${target}.`,
					result?.stderr.trim() ||
						result?.stdout.trim() ||
						`Command exited with code ${result?.code ?? "unknown"}.`,
				].join("\n\n"),
				"error",
			);
			return false;
		}

		reportMessage(ctx, `Opened worktree in ${target}.`, "info");
		return true;
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
	}
}

function currentWorkspaceRoot(repo: RepoState): string {
	return repo.worktrees.find((worktree) => worktree.isCurrent)?.path ?? repo.cwd;
}

export async function launchWorktreeInNewTab(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	cwd: string,
	options?: { sessionPath?: string },
): Promise<boolean> {
	const settings = readProjectWorktreeSettings(repo);
	const launchCommand = options?.sessionPath ? `pi --session ${quoteShellArg(options.sessionPath)}` : "pi";
	const commands = settings.newWorktreeTabCommand?.trim()
		? [renderLaunchCommand(settings.newWorktreeTabCommand, cwd, launchCommand)]
		: resolveTerminalLaunchCommands(cwd, launchCommand);
	if (commands.length === 0) {
		reportMessage(
			ctx,
			[
				"Could not determine how to open a new terminal for a new worktree and start pi.",
				"Configure wt.newWorktreeTabCommand in .pi/settings.json.",
				'Example: { "wt": { "newWorktreeTabCommand": "wezterm start --cwd {{path}} {{command}}" } }',
			].join("\n"),
			"error",
		);
		return false;
	}

	ctx.ui.setStatus("pi-wt", `Opening new terminal for ${cwd}...`);
	try {
		const result = await tryCommands(pi, cwd, commands);
		if (!result || result.code !== 0) {
			reportMessage(
				ctx,
				[
					"Failed to open a new terminal for the new worktree.",
					result?.stderr.trim() ||
						result?.stdout.trim() ||
						`Command exited with code ${result?.code ?? "unknown"}.`,
				].join("\n\n"),
				"error",
			);
			return false;
		}

		reportMessage(ctx, "Launched pi in a new terminal for the new worktree.", "info");
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
	const renderedWithPath = template.replaceAll("{{path}}", quotedPath);
	if (template.includes("{{command}}")) {
		return renderedWithPath.replaceAll("{{command}}", command);
	}

	const renderedWithExplicitPi = renderedWithPath.replace(/(^|[\s=])pi\s*$/, `$1${command}`);
	if (renderedWithExplicitPi !== renderedWithPath) {
		return renderedWithExplicitPi;
	}
	if (renderedWithPath === template) {
		return `${template} ${quotedPath} ${command}`;
	}
	return `${renderedWithPath} ${command}`;
}

function resolveFallbackOpenCommands(target: OpenTarget, cwd: string): string[] {
	if (target === "editor") {
		const preferredEditor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
		if (preferredEditor) {
			return [renderOpenCommand(preferredEditor, cwd)];
		}
	}

	return uniqueCommands([
		getTermProgramCandidate(target, process.platform, process.env.TERM_PROGRAM),
		...getFallbackCandidates(target, process.platform),
	]).map((candidate) => renderOpenCommand(candidate.command, cwd));
}

function resolveTerminalLaunchCommands(cwd: string, launchCommand: string): string[] {
	return uniqueCommands([
		getTerminalLaunchTermProgramCandidate(process.platform, process.env.TERM_PROGRAM, cwd, launchCommand),
		...getTerminalLaunchFallbackCandidates(process.platform, cwd, launchCommand),
	]).map((candidate) => candidate.command);
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
		return { probe: "osascript", command: buildGhosttyOpenCommand() };
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
		return { probe: "osascript", command: buildGhosttyLaunchCommand(cwd, launchCommand) };
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
		return [
			{ probe: "osascript", command: buildGhosttyOpenCommand() },
			{ probe: "open", command: "open -a Terminal {{path}}" },
		];
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
			{ probe: "osascript", command: buildGhosttyLaunchCommand(cwd, launchCommand) },
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

async function tryCommands(pi: ExtensionAPI, cwd: string, commands: string[]): Promise<ExecResult | null> {
	let lastResult: ExecResult | null = null;
	for (const command of commands) {
		lastResult = await execShell(pi, command, cwd);
		if (lastResult.code === 0) {
			return lastResult;
		}
	}
	return lastResult;
}

function uniqueCommands<T extends { command: string }>(candidates: Array<T | null | undefined>): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const candidate of candidates) {
		if (!candidate || seen.has(candidate.command)) {
			continue;
		}
		seen.add(candidate.command);
		result.push(candidate);
	}
	return result;
}

export function buildGhosttyOpenScript(): string {
	return buildGhosttySurfaceScript([], ["      set initial working directory to cwd"]);
}

function buildGhosttyOpenCommand(): string {
	return buildOsaScriptCommand(["{{path}}"], buildGhosttyOpenScript());
}

export function buildGhosttyLaunchScript(): string {
	return buildGhosttySurfaceScript(
		["  set launchCommand to item 2 of argv"],
		["      set initial working directory to cwd", "      set initial input to launchCommand & return"],
	);
}

function buildGhosttyLaunchCommand(cwd: string, launchCommand: string): string {
	return buildOsaScriptCommand([cwd, launchCommand], buildGhosttyLaunchScript());
}

function buildGhosttySurfaceScript(argvSetupLines: string[], configLines: string[]): string {
	return [
		"on run argv",
		"  set cwd to item 1 of argv",
		...argvSetupLines,
		'  set ghosttyRunning to application "Ghostty" is running',
		'  tell application "Ghostty"',
		"    set cfg to new surface configuration",
		"    tell cfg",
		...configLines,
		"    end tell",
		"    if ghosttyRunning and (count of windows) > 0 then",
		"      new tab in front window with configuration cfg",
		"    else",
		"      new window with configuration cfg",
		"    end if",
		"    activate",
		"  end tell",
		"end run",
	].join("\n");
}

function buildOsaScriptCommand(args: string[], script: string): string {
	const quotedArgs = args.map(quoteShellArg).join(" ");
	return `osascript - ${quotedArgs} <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`;
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
