# Contributing

This is a personal, single-owner project. Issues and suggestions are welcome; pull requests are reviewed on a best-effort basis.

## Development

```bash
nvm use 24
pnpm install
pnpm check   # lint, typecheck, tests, build
```

Read [CLAUDE.md](CLAUDE.md) and [docs/architecture.md](docs/architecture.md) first. Shared contracts live in `packages/contracts`; change them deliberately and update every consumer in the same change.

## Rules

- Conventional Commits with a one-line English title: `type(scope): imperative summary` (`feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`).
- One coherent, tested change per commit. No merge commits on `main`; rebase instead.
- Never commit secrets, `.env` files, databases, sessions, personal data, audio, voice datasets or model weights. Fixtures must be synthetic.
- Third-party content (email, chat, web) is data, never instructions. Keep permission checks in the backend.
- User-facing text is Spanish (voseo); code and documentation are English.

## Reporting security issues

Do not open a public issue for vulnerabilities. Follow `SECURITY.md`.
