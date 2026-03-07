# Repository Guidelines

## Project Structure & Module Organization
Hermes is a Node.js 20+ TypeScript CLI for exposing ACP agents to chat platforms. Source lives under `src/`: `src/config/` handles config loading and onboarding, `src/core/` contains ACP, routing, orchestration, state, and security logic, and `src/adapters/` contains channel integrations such as Telegram and the Discord placeholder. Tests live in `tests/unit/` and `tests/integration/`. Supporting docs are in `docs/`, and `tools/fake-acp-agent.ts` is used by integration coverage.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: run the CLI via `tsx` against source files for local development.
- `npm run build`: compile TypeScript to `dist/`.
- `npm test`: run the full Vitest suite once.
- `npm run test:watch`: run Vitest in watch mode while iterating.
- `npm run release:check`: build and test the package before publishing.

Use `npx hermes-gateway onboard` to generate `~/.hermes/config.yaml`, then `npx hermes-gateway` or `npm run dev -- start` to launch locally.

## Coding Style & Naming Conventions
Use TypeScript with strict compiler settings and ESM imports. Follow the existing style: 2-space indentation, double quotes, trailing commas in multiline literals, and explicit `.js` import suffixes for local modules. Prefer descriptive PascalCase for classes (`ChatOrchestrator`), camelCase for functions and variables (`loadConfig`), and kebab-case for docs filenames (`discord-v2.md`). Keep modules focused; place channel-specific code under `src/adapters/<channel>/` and shared runtime logic under `src/core/`.

## Testing Guidelines
Vitest is the test runner. Add unit tests under `tests/unit/` for isolated logic and `tests/integration/` for end-to-end ACP flows. Name files `*.test.ts` and mirror the source area when practical, for example `tests/unit/command-router.test.ts`. Cover both happy paths and failure cases, especially config validation, command routing, and permission handling. Run `npm test` before opening a PR.

## Commit & Pull Request Guidelines
Recent history uses short, imperative commit subjects such as `Add ACP model commands` and `Move Hermes config to user home`. Keep commits focused and descriptive. Pull requests should summarize behavior changes, note config or CLI impacts, link the relevant issue when applicable, and include command output or screenshots for user-facing chat-flow changes. Confirm `npm run build` and `npm test` pass before requesting review.

## Configuration & Security Tips
Do not commit bot tokens or local config files. Store runtime secrets in environment variables or `~/.hermes/config.yaml`. When changing access control or permission approval behavior, update both tests and documentation so operators can review the security impact quickly.
