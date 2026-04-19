import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { execShell, inspectRepo } from "../git.js";
import { readProjectWorktreeSettings } from "../worktrees.js";

type OpenTarget = "editor" | "terminal";

interface CommandCandidate {
	probe?: string;
	command: string;
}

export async function handleEditorCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	await handleOpenCommand(pi, ctx, "editor");
}

export async function handleTerminalCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	await handleOpenCommand(pi, ctx, "terminal");
}

async function handleOpenCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, target: OpenTarget): Promise<void> {
	const repo = await inspectRepo(pi, ctx.cwd);
	if (!repo) {
		ctx.ui.notify(`/wt ${target} must be run inside a git repository`, "error");
		return;
	}

	const settings = readProjectWorktreeSettings(repo);
	const configuredCommand = target === "editor" ? settings.editorCommand : settings.terminalCommand;
	const command = configuredCommand
		? renderOpenCommand(configuredCommand, repo.cwd)
		: await resolveFallbackOpenCommand(pi, target, repo.cwd);
	if (!command) {
		ctx.ui.notify(
			[
				`Could not determine a ${target} command for this machine.`,
				`Configure wt.${target}Command in .pi/settings.json.`,
				`Example: { "wt": { "${target}Command": "${exampleCommand(target)}" } }`,
			].join("\n"),
			"error",
		);
		return;
	}

	ctx.ui.setStatus("pi-wt", `Opening ${target} for ${repo.currentBranch ?? repo.cwd}...`);
	try {
		const result = await execShell(pi, command, repo.cwd);
		if (result.code !== 0) {
			ctx.ui.notify(
				[
					`Failed to open ${target}.`,
					result.stderr.trim() || result.stdout.trim() || `Command exited with code ${result.code}.`,
				].join("\n\n"),
				"error",
			);
			return;
		}

		ctx.ui.notify(`Opened current worktree in ${target}.`, "info");
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
	}
}

function renderOpenCommand(template: string, cwd: string): string {
	const quotedPath = quoteShellArg(cwd);
	const rendered = template.replaceAll("{{path}}", quotedPath);
	return rendered === template ? `${template} ${quotedPath}` : rendered;
}

async function resolveFallbackOpenCommand(pi: ExtensionAPI, target: OpenTarget, cwd: string): Promise<string | null> {
	if (target === "editor") {
		const preferredEditor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
		if (preferredEditor) {
			return renderOpenCommand(preferredEditor, cwd);
		}
	}

	const candidates = getFallbackCandidates(target, process.platform);
	for (const candidate of candidates) {
		if (!candidate.probe || (await commandExists(pi, candidate.probe, cwd))) {
			return renderOpenCommand(candidate.command, cwd);
		}
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
