import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { complete, type UserMessage } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	ExtensionEditorComponent,
} from "@mariozechner/pi-coding-agent";
import { exec, summarizeCommandOutput } from "./git.js";
import { cancelIfAborted } from "./shared.js";
import type { BaseBranchSelection, CommitDraft, RepoState } from "./types.js";

const PROJECT_COMMIT_PROMPT_PATH = ".pi/wt/commit.md";
const DEFAULT_COMMIT_PROMPT_PATH = fileURLToPath(new URL("../prompts/wt/commit.md", import.meta.url));
const COMMIT_DRAFT_SYSTEM_PROMPT = [
	"You write concise, high-signal Git commit messages.",
	"Follow the user's markdown prompt exactly.",
	"Return only the requested <title> and <body> tags with no extra commentary.",
].join(" ");

export async function generateCommitDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	cwd: string,
	featureBranch: string,
	baseBranch: BaseBranchSelection,
): Promise<CommitDraft | null> {
	if (!ctx.model) {
		return null;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) {
		return null;
	}

	const promptTemplate = await readCommitPromptTemplate(repo.mainCheckoutPath);
	const prompt = await buildCommitPrompt(pi, repo, cwd, featureBranch, baseBranch, promptTemplate.template);
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model,
		{
			systemPrompt: COMMIT_DRAFT_SYSTEM_PROMPT,
			messages: [userMessage],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal: ctx.signal,
		},
	);
	if (response.stopReason === "aborted") {
		return null;
	}

	const output = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	const draft = parseCommitDraft(output);
	if (!draft) {
		return null;
	}

	return {
		...draft,
		promptPath: promptTemplate.path,
	};
}

export async function promptForCommitMessage(
	ctx: ExtensionCommandContext,
	title: string,
	prefill?: string,
): Promise<string | undefined> {
	while (true) {
		const edited = await ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
			return new ExtensionEditorComponent(
				tui,
				keybindings,
				title,
				prefill,
				(value) => done(value),
				() => done(undefined),
			);
		});
		if (edited === undefined) {
			return undefined;
		}

		const normalized = normalizeCommitMessage(edited);
		if (normalized) {
			return normalized;
		}

		ctx.ui.notify("Commit message subject is required", "warning");
		prefill = edited;
	}
}

export async function commitAllChangesWithDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	cwd: string,
	featureBranch: string,
	baseBranch: BaseBranchSelection,
	options?: {
		actionLabel?: string;
		promptTitle?: string;
	},
): Promise<boolean> {
	let draft = null;
	try {
		ctx.ui.setStatus("pi-wt", `Drafting commit for ${featureBranch}...`);
		draft = await generateCommitDraft(pi, ctx, repo, cwd, featureBranch, baseBranch);
	} catch {
		draft = null;
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
	}

	if (!draft) {
		ctx.ui.notify("Could not draft a commit message. Enter one manually.", "info");
	}

	const commitMessage = await promptForCommitMessage(
		ctx,
		options?.promptTitle ?? `Commit message · ${featureBranch}`,
		renderCommitDraftMessage(draft),
	);
	if (!commitMessage) {
		ctx.ui.notify("Cancelled", "info");
		return false;
	}

	const tempDir = await mkdtemp(join(tmpdir(), "pi-wt-commit-"));
	const messagePath = join(tempDir, "COMMIT_EDITMSG");
	try {
		await writeFile(messagePath, `${commitMessage.trimEnd()}\n`, "utf8");

		ctx.ui.setStatus("pi-wt", `Staging changes for ${featureBranch}...`);
		const staged = await exec(pi, "git", ["add", "-A"], cwd, { signal: ctx.signal });
		if (cancelIfAborted(ctx)) {
			return false;
		}
		if (staged.code !== 0) {
			ctx.ui.notify(
				[`Failed to stage changes in ${cwd}.`, summarizeCommandOutput(staged) || "git add -A failed"].join("\n\n"),
				"error",
			);
			return false;
		}

		ctx.ui.setStatus("pi-wt", `${options?.actionLabel ?? "Committing changes"} in ${featureBranch}...`);
		const committed = await exec(pi, "git", ["commit", "-F", messagePath], cwd, { signal: ctx.signal });
		if (cancelIfAborted(ctx)) {
			return false;
		}
		if (committed.code !== 0) {
			ctx.ui.notify(
				[
					`Failed to commit changes in ${featureBranch}.`,
					draft ? `Prompt: ${draft.promptPath}` : null,
					summarizeCommandOutput(committed) || "git commit failed",
				]
					.filter(Boolean)
					.join("\n\n"),
				"error",
			);
			return false;
		}

		return true;
	} finally {
		ctx.ui.setStatus("pi-wt", undefined);
		await rm(tempDir, { recursive: true, force: true });
	}
}

export function renderCommitDraftMessage(draft: CommitDraft | null): string {
	if (!draft) {
		return "";
	}

	return renderCommitMessage(draft.title, draft.body);
}

function renderCommitMessage(title: string, body: string): string {
	return body.trim().length > 0 ? `${title.trim()}\n\n${body.trim()}` : title.trim();
}

async function readCommitPromptTemplate(repoRoot: string): Promise<{ path: string; template: string }> {
	const projectPath = resolve(repoRoot, PROJECT_COMMIT_PROMPT_PATH);
	if (await pathExists(projectPath)) {
		return {
			path: projectPath,
			template: await readFile(projectPath, "utf8"),
		};
	}

	return {
		path: DEFAULT_COMMIT_PROMPT_PATH,
		template: await readFile(DEFAULT_COMMIT_PROMPT_PATH, "utf8"),
	};
}

async function buildCommitPrompt(
	pi: ExtensionAPI,
	repo: RepoState,
	cwd: string,
	featureBranch: string,
	baseBranch: BaseBranchSelection,
	template: string,
): Promise<string> {
	const [statusShort, untrackedFiles, diffStat, diffPatch] = await Promise.all([
		readGitText(pi, cwd, ["status", "--short"]),
		readGitText(pi, cwd, ["ls-files", "--others", "--exclude-standard"]),
		readGitText(pi, cwd, ["diff", "--stat", "--find-renames", "HEAD"]),
		readGitText(pi, cwd, ["diff", "--no-color", "--find-renames", "--unified=1", "HEAD"]),
	]);

	const values = {
		repo_root: repo.repoRoot,
		worktree_path: cwd,
		head_branch: featureBranch,
		base_branch: baseBranch.name,
		base_ref: baseBranch.ref,
		status_short: statusShort || "(none)",
		untracked_files: untrackedFiles || "(none)",
		diff_stat: diffStat || "(none)",
		diff_patch: truncateBlock(diffPatch || "(none)", 20000),
	};

	return template.replace(/{{\s*([a-z_]+)\s*}}/gi, (match, rawKey: string) => {
		const key = rawKey.toLowerCase() as keyof typeof values;
		return values[key] ?? match;
	});
}

function parseCommitDraft(output: string): { title: string; body: string } | null {
	const titleMatch = output.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
	const bodyMatch = output.match(/<body>\s*([\s\S]*?)\s*<\/body>/i);
	if (!titleMatch || !bodyMatch) {
		return null;
	}

	const title = titleMatch[1].replace(/\s+/g, " ").trim();
	const body = bodyMatch[1].trim();
	if (!title) {
		return null;
	}

	return { title, body };
}

function normalizeCommitMessage(text: string): string | null {
	const normalized = text
		.replace(/\r\n?/g, "\n")
		.replace(/^\s*\n+/, "")
		.trimEnd();
	const subject = normalized
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean);
	return subject ? normalized : null;
}

async function readGitText(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const result = await exec(pi, "git", args, cwd);
	return result.code === 0 ? result.stdout.trim() : "";
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function truncateBlock(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}

	return `${text.slice(0, Math.max(0, maxChars - 40)).trimEnd()}\n\n[truncated ${text.length - maxChars} chars]`;
}
