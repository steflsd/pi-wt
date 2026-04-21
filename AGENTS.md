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
- `pnpm run test`

## Testing
- Use Vitest v4
- Test public behavior and observable outcomes, not implementation details
- Prefer the lightest mocking tool: use `vi.spyOn` before `vi.mock`
- Do not mock entire modules unless necessary
- Keep tests isolated; do not rely on mock or timer state leaking between tests
- Preserve type safety for mocks; prefer `vi.mocked(...)` and avoid `any` casts
- Structure tests as Arrange / Act / Assert
- Always `await` Promise-returning functions and async assertions
- If using fake timers, explicitly advance them and restore real timers after each test
- Prefer meaningful behavioral tests over tests written only for coverage
- Default Vitest config should enable:
  - `mockReset: true`
  - `restoreMocks: true`

## Project structure
- Keep `src/index.ts` thin
- Put `/wt` subcommand handlers in `src/commands/`
- Put shared logic in top-level modules like `src/git.ts`, `src/worktrees.ts`, `src/sessions.ts`, and `src/shared.ts`

## Changes
- Keep changes focused and minimal
- Prefer precise edits over broad rewrites
