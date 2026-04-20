Write a Git commit message for the current working tree changes.

Goals:
- Produce a clear, specific subject line.
- Summarize the actual code changes without inventing details.
- Keep the subject concise and imperative when possible.
- Include a body only when it adds useful context.
- Do not mention tests, tickets, or follow-up work unless the diff supports it.

Return exactly this format:
<title>Commit subject here</title>
<body>
Optional body paragraphs or bullets.
</body>

Repository root: {{repo_root}}
Worktree path: {{worktree_path}}
Head branch: {{head_branch}}
Base branch: {{base_branch}}
Base ref used for git commands: {{base_ref}}

Status:
{{status_short}}

Untracked files:
{{untracked_files}}

Diff stat:
{{diff_stat}}

Patch excerpt:
{{diff_patch}}
