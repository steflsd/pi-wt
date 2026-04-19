# AGENTS.md

## Package manager
- Use `pnpm`, not `npm`
- Prefer `pnpm run <script>` for repo scripts
- Do not create or update `package-lock.json`

## Validation
After code changes, run:
- `pnpm run format`
- `pnpm run lint`
- `pnpm run typecheck`

## Project structure
- Keep `src/index.ts` thin
- Put `/wt` subcommand handlers in `src/commands/`
- Put shared logic in top-level modules like `src/git.ts`, `src/worktrees.ts`, `src/sessions.ts`, and `src/shared.ts`

## Changes
- Keep changes focused and minimal
- Prefer precise edits over broad rewrites
