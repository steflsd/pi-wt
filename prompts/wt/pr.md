Write a GitHub pull request for this branch.

Goals:
- Produce a clear, specific title.
- Summarize the user-visible and code-level changes.
- Mention any follow-up work or caveats only when supported by the context.
- Do not invent tests, tickets, or implementation details.
- Keep the body concise but useful.

Return exactly this format:
<title>PR title here</title>
<body>
## Summary
- bullet
- bullet

## Testing
- bullet
</body>

Repository root: {{repo_root}}
Head branch: {{head_branch}}
Base branch: {{base_branch}}
Base ref used for git commands: {{base_ref}}

Commits:
{{commit_list}}

Changed files:
{{changed_files}}

Diff stat:
{{diff_stat}}

Patch excerpt:
{{diff_patch}}
