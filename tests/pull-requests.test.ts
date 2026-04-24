import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { createPullRequest } from "../src/pull-requests.js";

describe("createPullRequest", () => {
	test("passes --head and generated title/body to gh pr create", async () => {
		// Arrange
		const exec = vi.fn(async () => ({
			stdout: "https://example.com/pr/1\n",
			stderr: "",
			code: 0,
			killed: false,
		}));
		const pi = { exec } satisfies Pick<ExtensionAPI, "exec">;

		// Act
		const created = await createPullRequest(pi, "/repo", "feature/example", "main", {
			title: "Example PR",
			body: "PR body",
			promptPath: "/repo/.pi/wt/pr.md",
		});

		// Assert
		expect(created.mode).toBe("generated");
		expect(exec).toHaveBeenCalledWith(
			"gh",
			["pr", "create", "--head", "feature/example", "--base", "main", "--title", "Example PR", "--body", "PR body"],
			{ cwd: "/repo" },
		);
	});

	test("passes --head to gh pr create when falling back to --fill", async () => {
		// Arrange
		const exec = vi.fn(async () => ({
			stdout: "https://example.com/pr/1\n",
			stderr: "",
			code: 0,
			killed: false,
		}));
		const pi = { exec } satisfies Pick<ExtensionAPI, "exec">;

		// Act
		const created = await createPullRequest(pi, "/repo", "feature/example", "main", null);

		// Assert
		expect(created.mode).toBe("fill");
		expect(exec).toHaveBeenCalledWith(
			"gh",
			["pr", "create", "--fill", "--head", "feature/example", "--base", "main"],
			{ cwd: "/repo" },
		);
	});
});
