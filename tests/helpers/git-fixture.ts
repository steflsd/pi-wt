import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export interface WorktreeRepoFixture {
	rootDir: string;
	repoPath: string;
	featureBranch: string;
	featureWorktreePath: string;
	pi: ExtensionAPI;
	cleanup(): Promise<void>;
	git(args: string[], cwd?: string): CommandResult;
	writeMainFile(path: string, content: string): Promise<void>;
	writeFeatureFile(path: string, content: string): Promise<void>;
}

export async function createWorktreeRepoFixture(): Promise<WorktreeRepoFixture> {
	const tempRootDir = await mkdtemp(join(tmpdir(), "pi-wt-"));
	const rootDir = realpathSync(tempRootDir);
	const repoPath = join(rootDir, "repo");
	const featureBranch = "feature/landing";
	const featureWorktreePath = join(rootDir, "worktrees", "repo", "feature-landing");

	const run = (command: string, args: string[], cwd: string): CommandResult => {
		const result = spawnSync(command, args, {
			cwd,
			encoding: "utf8",
		});
		if (result.error) {
			throw result.error;
		}
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			code: result.status ?? -1,
			killed: result.signal !== null,
		};
	};

	const runChecked = (command: string, args: string[], cwd: string): CommandResult => {
		const result = run(command, args, cwd);
		if (result.code !== 0) {
			throw new Error(
				`${command} ${args.join(" ")} failed in ${cwd}\n${[result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")}`,
			);
		}
		return result;
	};

	const git = (args: string[], cwd = repoPath) => runChecked("git", args, cwd);
	const pi = {
		exec: async (command: string, args: string[], options: { cwd: string }) => run(command, args, options.cwd),
	} satisfies Pick<ExtensionAPI, "exec">;

	await mkdir(rootDir, { recursive: true });
	git(["init", "-b", "main", repoPath], rootDir);
	git(["config", "user.name", "Test User"]);
	git(["config", "user.email", "test@example.com"]);

	await writeRepoFile(repoPath, "README.md", "# pi-wt test repo\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "Initial commit"]);

	await mkdir(dirname(featureWorktreePath), { recursive: true });
	git(["worktree", "add", "-b", featureBranch, featureWorktreePath, "main"]);
	git(["config", `branch.${featureBranch}.wt-parent`, "main"]);

	await writeRepoFile(featureWorktreePath, "feature.txt", "feature change\n");
	git(["add", "feature.txt"], featureWorktreePath);
	git(["commit", "-m", "Feature commit"], featureWorktreePath);

	return {
		rootDir,
		repoPath,
		featureBranch,
		featureWorktreePath,
		pi: pi as ExtensionAPI,
		cleanup: async () => {
			await rm(rootDir, { recursive: true, force: true });
		},
		git,
		writeMainFile: (path: string, content: string) => writeRepoFile(repoPath, path, content),
		writeFeatureFile: (path: string, content: string) => writeRepoFile(featureWorktreePath, path, content),
	};
}

async function writeRepoFile(root: string, path: string, content: string): Promise<void> {
	const targetPath = join(root, path);
	await mkdir(dirname(targetPath), { recursive: true });
	await writeFile(targetPath, content, "utf8");
}
