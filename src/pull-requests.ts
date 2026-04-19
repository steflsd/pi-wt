import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { exec, summarizeCommandOutput } from "./git.js";
import type { BaseBranchSelection, PullRequestDraft, RepoState } from "./types.js";

const PROJECT_PR_PROMPT_PATH = ".pi/wt/pr.md";
const LEGACY_PROJECT_PR_PROMPT_PATH = ".pi/wt-pr.md";
const DEFAULT_PR_PROMPT_PATH = fileURLToPath(new URL("../prompts/wt/pr.md", import.meta.url));
const PR_DRAFT_SYSTEM_PROMPT = [
	"You write concise, high-signal GitHub pull requests.",
	"Follow the user's markdown prompt exactly.",
	"Return only the requested <title> and <body> tags with no extra commentary.",
].join(" ");

export async function generatePullRequestDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoState,
	baseBranch: BaseBranchSelection,
): Promise<PullRequestDraft | null> {
	if (!ctx.model) {
		return null;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) {
		return null;
	}

	const promptTemplate = await readPullRequestPromptTemplate(repo.repoRoot);
	const prompt = await buildPullRequestPrompt(pi, repo, baseBranch, promptTemplate.template);
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model,
		{
			systemPrompt: PR_DRAFT_SYSTEM_PROMPT,
			messages: [userMessage],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
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
	const draft = parsePullRequestDraft(output);
	if (!draft) {
		return null;
	}

	return {
		...draft,
		promptPath: promptTemplate.path,
	};
}

async function readPullRequestPromptTemplate(repoRoot: string): Promise<{ path: string; template: string }> {
	for (const path of [PROJECT_PR_PROMPT_PATH, LEGACY_PROJECT_PR_PROMPT_PATH]) {
		const projectPath = resolve(repoRoot, path);
		if (await pathExists(projectPath)) {
			return {
				path: projectPath,
				template: await readFile(projectPath, "utf8"),
			};
		}
	}

	return {
		path: DEFAULT_PR_PROMPT_PATH,
		template: await readFile(DEFAULT_PR_PROMPT_PATH, "utf8"),
	};
}

async function buildPullRequestPrompt(
	pi: ExtensionAPI,
	repo: RepoState,
	baseBranch: BaseBranchSelection,
	template: string,
): Promise<string> {
	const [commitList, changedFiles, diffStat, diffPatch] = await Promise.all([
		readGitText(pi, repo.cwd, ["log", "--reverse", "--format=- %s (%h)", `${baseBranch.ref}..HEAD`]),
		readGitText(pi, repo.cwd, ["diff", "--name-status", "--find-renames", `${baseBranch.ref}...HEAD`]),
		readGitText(pi, repo.cwd, ["diff", "--stat", "--find-renames", `${baseBranch.ref}...HEAD`]),
		readGitText(pi, repo.cwd, ["diff", "--no-color", "--find-renames", "--unified=1", `${baseBranch.ref}...HEAD`]),
	]);

	const values = {
		repo_root: repo.repoRoot,
		head_branch: repo.currentBranch ?? "",
		base_branch: baseBranch.name,
		base_ref: baseBranch.ref,
		commit_list: commitList || "(none)",
		changed_files: changedFiles || "(none)",
		diff_stat: diffStat || "(none)",
		diff_patch: truncateBlock(diffPatch || "(none)", 20000),
	};

	return template.replace(/{{\s*([a-z_]+)\s*}}/gi, (match, rawKey: string) => {
		const key = rawKey.toLowerCase() as keyof typeof values;
		return values[key] ?? match;
	});
}

function parsePullRequestDraft(output: string): { title: string; body: string } | null {
	const titleMatch = output.match(/<title>\s*([\s\S]*?)\s*<\/title>/i);
	const bodyMatch = output.match(/<body>\s*([\s\S]*?)\s*<\/body>/i);
	if (!titleMatch || !bodyMatch) {
		return null;
	}

	const title = titleMatch[1].replace(/\s+/g, " ").trim();
	const body = bodyMatch[1].trim();
	if (!title || !body) {
		return null;
	}

	return { title, body };
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

export async function createPullRequest(
	pi: ExtensionAPI,
	cwd: string,
	baseBranch: string,
	draft: PullRequestDraft | null,
): Promise<{ result: Awaited<ReturnType<typeof exec>>; mode: "generated" | "fill" }> {
	if (draft) {
		const result = await exec(
			pi,
			"gh",
			["pr", "create", "--base", baseBranch, "--title", draft.title, "--body", draft.body],
			cwd,
		);
		return { result, mode: "generated" };
	}

	const result = await exec(pi, "gh", ["pr", "create", "--fill", "--base", baseBranch], cwd);
	return { result, mode: "fill" };
}

export function summarizeCreatePullRequestResult(output: Awaited<ReturnType<typeof exec>>): string {
	return summarizeCommandOutput(output);
}
