import { describe, expect, test } from "vitest";
import { inspectRepo } from "../src/git.js";
import { evaluateLandingReadiness, inspectLandingFacts } from "../src/landing.js";
import { createWorktreeRepoFixture, type WorktreeRepoFixture } from "./helpers/git-fixture.js";

async function withFixture(run: (fixture: WorktreeRepoFixture) => Promise<void>) {
	const fixture = await createWorktreeRepoFixture();
	try {
		await run(fixture);
	} finally {
		await fixture.cleanup();
	}
}

describe("critical git worktree flows", () => {
	test("inspectRepo recognizes the current linked worktree and main checkout", async () => {
		await withFixture(async (fixture) => {
			// Arrange

			// Act
			const repo = await inspectRepo(fixture.pi, fixture.featureWorktreePath);

			// Assert
			expect(repo).not.toBeNull();
			expect(repo).toMatchObject({
				cwd: fixture.featureWorktreePath,
				mainCheckoutPath: fixture.repoPath,
				currentBranch: fixture.featureBranch,
			});
			expect(repo?.worktrees).toHaveLength(2);
			expect(
				repo?.worktrees.map((worktree) => ({
					path: worktree.path,
					branch: worktree.branch,
					isCurrent: worktree.isCurrent,
					isMainCheckout: worktree.isMainCheckout,
				})),
			).toEqual(
				expect.arrayContaining([
					{
						path: fixture.featureWorktreePath,
						branch: fixture.featureBranch,
						isCurrent: true,
						isMainCheckout: false,
					},
					{
						path: fixture.repoPath,
						branch: "main",
						isCurrent: false,
						isMainCheckout: true,
					},
				]),
			);
		});
	});

	test("landing inspection is ready for a clean feature worktree", async () => {
		await withFixture(async (fixture) => {
			// Arrange
			const repo = await inspectRepo(fixture.pi, fixture.featureWorktreePath);
			expect(repo).not.toBeNull();
			if (!repo) {
				throw new Error("Expected a git repo");
			}

			// Act
			const facts = await inspectLandingFacts(fixture.pi, repo, fixture.featureWorktreePath, {
				featureChanges: "tracked",
				destinationChanges: "tracked",
			});

			// Assert
			expect(facts.featureBranch).toBe(fixture.featureBranch);
			expect(facts.baseBranch?.name).toBe("main");
			expect(facts.destination?.workspace.cwd).toBe(fixture.repoPath);
			expect(evaluateLandingReadiness(facts)).toEqual({ kind: "ready" });
		});
	});

	test("landing readiness blocks dirty feature worktrees", async () => {
		await withFixture(async (fixture) => {
			// Arrange
			await fixture.writeFeatureFile("scratch.txt", "dirty change\n");
			const repo = await inspectRepo(fixture.pi, fixture.featureWorktreePath);
			expect(repo).not.toBeNull();
			if (!repo) {
				throw new Error("Expected a git repo");
			}

			// Act
			const facts = await inspectLandingFacts(fixture.pi, repo, fixture.featureWorktreePath, {
				featureChanges: "all",
				destinationChanges: "tracked",
			});

			// Assert
			expect(evaluateLandingReadiness(facts).kind).toBe("feature-has-local-changes");
			expect(facts.featureChanges).toContain("?? scratch.txt");
		});
	});

	test("landing readiness blocks dirty destination checkouts", async () => {
		await withFixture(async (fixture) => {
			// Arrange
			await fixture.writeMainFile("dirty.txt", "dirty destination\n");
			const repo = await inspectRepo(fixture.pi, fixture.featureWorktreePath);
			expect(repo).not.toBeNull();
			if (!repo) {
				throw new Error("Expected a git repo");
			}

			// Act
			const facts = await inspectLandingFacts(fixture.pi, repo, fixture.featureWorktreePath, {
				featureChanges: "tracked",
				destinationChanges: "all",
			});

			// Assert
			expect(evaluateLandingReadiness(facts).kind).toBe("destination-has-local-changes");
			expect(facts.destinationChanges).toContain("?? dirty.txt");
		});
	});
});
