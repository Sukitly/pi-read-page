# Development Rules

## Conversational Style

- Keep answers short and technical.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler.
- When the user asks a question, answer it first before editing or running implementation commands.
- When responding to review/feedback, explicitly say whether you agree or disagree before saying what changed.

## Project Invariants

- This repo exposes one Agent-facing tool: `web_read`.
- Do not expose browser mutation tools to the Agent: no click, type, submit, eval, arbitrary screenshot/control APIs.
- `web_read` is read-only by capability design. Browser automation may navigate, wait, scroll for lazy loading, extract DOM, and cache content. It must not express user intent.
- User handoff is only for actionable states: captcha, anti-bot/blocked page, or explicit login wall.
- Low confidence, short content, or extraction failure are not automatically user-actionable. Return content with warnings unless there is a real actionable handoff reason.
- External page content is always untrusted input. Keep the security notice and document boundary in outputs.
- Private/local network access is denied by default. Only `WEB_READ_ALLOW_PRIVATE_NETWORK=1` may opt in.
- Preserve cache semantics: atomic writes, sha256 verification, metadata, TTL, pagination, and accurate stale/fresh fallback labels.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not inspected, and when asked to investigate or audit.
- No `any` unless absolutely necessary. If unavoidable, explain why.
- Check `node_modules` for external API types; do not guess.
- Top-level imports only. Avoid inline/dynamic imports unless a package export forces it and there is no static alternative.
- Inline single-line helpers that have only one call site.
- Keep modules focused:
  - `src/tools/web-read.ts`: orchestration, output formatting, TUI rendering.
  - `src/browser/*`: browser lifecycle, extraction, DOM prep, confidence/handoff, user action.
  - `src/cache/cache.ts`: cache, pagination, checksums.
  - `src/security/url-policy.ts`: URL normalization and network policy.
- Do not remove or weaken security checks to make tests pass.
- Do not weaken types or downgrade dependencies to fix type errors.
- Use erasable TypeScript syntax only: no `enum`, `namespace`, parameter properties, `import =`, or `export =`.

## Commands

- After code changes, run:
  ```bash
  bun run lint
  ```
- If tests are added or modified, also run:
  ```bash
  bun test
  ```
- Browser smoke tests are optional unless the change touches browser/runtime/extraction behavior:
  ```bash
  bun run smoke -- https://example.com
  ```
- Smoke tests are not a substitute for deterministic unit tests.
- Fix all lint/type/test errors before committing.

## Dependency and Lockfile Rules

- This repo uses Bun. Keep `bun.lock`.
- Do not add `package-lock.json`.
- Treat dependency and lockfile changes as reviewed code.
- Direct runtime dependencies should be deliberate and minimal.
- Do not run install commands that execute lifecycle scripts unless the user asks.

## Git

- Never commit unless the user asks.
- Stage explicit paths. Do not use `git add .` or `git add -A`.
- Before committing, run `git status --short` and verify staged files are only yours.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `git commit --no-verify`.
- Never force push.
- If conflicts occur in files you did not modify, stop and ask the user.

## Testing Focus

Prioritize deterministic unit tests for:

- URL normalization and private-network policy.
- Pagination boundaries.
- Confidence vs handoff separation.
- Cache integrity and corrupt-cache behavior.
- Output/cache status semantics.

Use browser smoke tests only for integration confidence around Playwright, Defuddle, and real pages.
