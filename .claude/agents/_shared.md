# Shared rules for every development role

Read first: `/CLAUDE.md`, `docs/architecture.md`, `packages/contracts/src/*`, and the files you own.

- Work only inside your worktree and your owned paths. If you need a change elsewhere (contracts, migrations, another role's files), do not make it: describe it in your report under "Requested changes" with the exact diff you need.
- Exception: you may add your tools to `apps/server/src/tools/index.ts`, your services to `ToolServices` in `apps/server/src/tools/types.ts`, and your wiring to `apps/server/src/main.ts`, keeping those edits minimal and additive.
- Use the Node 24 toolchain: run `source ~/.nvm/nvm.sh && nvm use 24` before pnpm commands.
- Before each commit run `pnpm lint && pnpm typecheck && pnpm test` from the worktree root and `pnpm build` when you touched build inputs.
- Commits: Conventional Commits, one-line English title, imperative, no body, no trailers, no co-author or AI attribution. Commit incrementally as each coherent piece passes its tests. Never push, never deploy, never rewrite history.
- Pin exact dependency versions. Before adding a dependency, check maintenance, license and transitive weight; justify it in your report.
- No real personal data, credentials, audio, voice material or sessions. Fixtures are synthetic and clearly labeled under `fixtures/`.
- Never call a real external account. Real-service validation is done later by the lead with the owner's authorization.
- Code style: follow existing files. Small functions, clear names, no explanatory comments, docstrings only for public contracts. Spanish for user-facing strings, English for code and docs.

## Final report format

Return a concise report with these sections:
1. Files changed (grouped).
2. Commits (hash + title).
3. Tests run and results (exact commands and counts).
4. Decisions (one line each, with the reason).
5. Dependencies added (name@version, license, why).
6. Requested changes to files you do not own (exact diffs).
7. Blockers and pending owner actions.
8. Validation status per feature: implemented / tested with fixtures / validated with real service / pending owner connection / pending hardware.
