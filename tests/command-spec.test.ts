import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { getWtArgumentCompletions } from "../src/command-spec.js";

function createPi(): Pick<ExtensionAPI, "exec"> {
	return {
		exec: async (_command: string, args: string[]) => {
			const key = args.join(" ");
			switch (key) {
				case "rev-parse --show-toplevel":
					return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
				case "rev-parse --path-format=absolute --git-common-dir":
					return { stdout: "/repo/.git\n", stderr: "", code: 0, killed: false };
				case "branch --show-current":
					return { stdout: "feature/current\n", stderr: "", code: 0, killed: false };
				case "symbolic-ref --quiet --short refs/remotes/origin/HEAD":
					return { stdout: "origin/main\n", stderr: "", code: 0, killed: false };
				case "worktree list --porcelain":
					return {
						stdout:
							"worktree /repo\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\n" +
							"worktree /repo-feature\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/feature/current\n",
						stderr: "",
						code: 0,
						killed: false,
					};
				case "for-each-ref --sort=-committerdate --format=%(refname:short) refs/heads":
					return {
						stdout: "feature/current\nmain\nrelease/1.0\n",
						stderr: "",
						code: 0,
						killed: false,
					};
				default:
					throw new Error(`Unexpected git args: ${key}`);
			}
		},
	};
}

describe("getWtArgumentCompletions", () => {
	test("returns top-level /wt subcommand completions", async () => {
		// Arrange
		const pi = createPi();

		// Act
		const completions = await getWtArgumentCompletions(pi, "/repo", "re");

		// Assert
		expect(completions).toEqual([
			{
				value: "rebase",
				label: "update the current branch by rebasing onto its detected base branch; requires a clean working tree",
			},
		]);
	});

	test("suggests local base branches for /wt rebase and excludes the current branch", async () => {
		// Arrange
		const pi = createPi();

		// Act
		const completions = await getWtArgumentCompletions(pi, "/repo", "rebase ma");

		// Assert
		expect(completions).toEqual([{ value: "main", label: "main", description: "default · checked out · /repo" }]);
	});

	test("lists all non-current branches for /wt pr with an empty base prefix", async () => {
		// Arrange
		const pi = createPi();

		// Act
		const completions = await getWtArgumentCompletions(pi, "/repo", "pr ");

		// Assert
		expect(completions).toEqual([
			{ value: "main", label: "main", description: "default · checked out · /repo" },
			{ value: "release/1.0", label: "release/1.0", description: undefined },
		]);
	});
});
