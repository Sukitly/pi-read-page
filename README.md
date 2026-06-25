# pi-read-page

Let [pi](https://github.com/earendil-works/pi-coding-agent) read webpages through your local browser and return Markdown.

## What it provides

- One read-only Agent tool: `read-page`.
- Local Chrome/Chromium rendering.
- Manual handoff for login/captcha/blocked states.
- Markdown output with pagination and cache.
- Defensive defaults for untrusted webpages and private-network access.

## Requirements

- pi.
- A local Chrome/Chromium browser.
- Bun only if you are developing or running tests locally.

`pi-read-page` uses `playwright-core`; it does not download a browser. By default it launches the `chrome` channel. Set `READ_PAGE_CHROME_PATH` or `READ_PAGE_BROWSER_CHANNEL` if needed.

## Installation

Install from npm:

```bash
pi install npm:pi-read-page
```

Try it for one pi run without installing:

```bash
pi -e npm:pi-read-page
```

Install from GitHub if you want the latest repository version:

```bash
pi install https://github.com/Sukitly/pi-read-page
```

Use a local checkout:

```bash
git clone https://github.com/Sukitly/pi-read-page.git
cd pi-read-page
bun install
pi -e .
```

## Usage

Ask pi to read a URL:

```text
Read https://example.com
```

The extension registers one Agent-facing tool:

```text
read-page(url, offset?, limit?, refresh?, preserveQuery?)
```

Parameters:

| Parameter | Default | Description |
| --- | --- | --- |
| `url` | required | HTTP or HTTPS URL to read. |
| `offset` | `1` | 1-based line offset for pagination. |
| `limit` | `300` | Number of lines to return. Maximum `1000`. |
| `refresh` | `false` | Force browser re-extraction and overwrite cache. |
| `preserveQuery` | `false` | Preserve URL query parameters. By default query params are stripped for canonical cache keys. |

Use the returned `Next offset` to continue reading long pages.

## How extraction works

```text
URL normalization and private-network policy
  -> headed Playwright browser
  -> DOMContentLoaded + network idle wait
  -> final URL private-network policy
  -> read-only lazy-load scroll
  -> open shadow-root flattening
  -> URL absolutization
  -> Defuddle HTML/Markdown extraction
  -> confidence and handoff detection
  -> local cache write
  -> paginated Markdown output
```

If the page appears to require a real user action, pi shows a confirmation prompt and leaves the headed browser open. Complete the login/captcha/manual navigation in that browser, then confirm in pi. The same browser page is settled and extracted again. After the tool call completes, the page and browser context are closed.

## Cache

Successful browser extractions are cached under:

```text
~/.pi/agent/caches/read-page
```

Cache behavior:

- Normal TTL: 30 days.
- User-action TTL: 1 day.
- Cache files: `content.md` and `meta.json`.
- Writes are atomic.
- Cached Markdown is sha256-verified on load.
- If refresh/extraction fails and a cache entry exists, the tool returns cached content with an explicit `refresh-failed-fresh` or `stale-fallback` status.

## Security model

`read-page` treats webpages as untrusted external content.

- The output includes a security notice and document boundary.
- The Agent is instructed not to follow instructions from the page unless the user explicitly asks.
- Private/local hosts and IPs are blocked by default.
- Browser automation is read-only: it may navigate, wait, scroll, extract DOM, and cache content.
- The extension does not expose browser mutation/control tools to the Agent.
- User handoff is only used for actionable captcha, blocked/interstitial, or explicit login-wall states.

To intentionally allow private/local network URLs:

```bash
READ_PAGE_ALLOW_PRIVATE_NETWORK=1 pi
```

## Configuration

Optional environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `READ_PAGE_CHROME_PATH` | unset | Explicit Chrome/Chromium executable path. |
| `READ_PAGE_BROWSER_CHANNEL` | `chrome` | Playwright browser channel. |
| `READ_PAGE_PROFILE_DIR` | `~/.pi/agent/read-page/browser-profile` | Persistent browser profile directory. |
| `READ_PAGE_DISABLE_TEMP_PROFILE_FALLBACK` | unset | Set to `1` to fail instead of using a temporary profile when the persistent profile is locked. |
| `READ_PAGE_ALLOW_PRIVATE_NETWORK` | unset | Set to `1` to allow private/local network access. |
| `READ_PAGE_PARSE_TIMEOUT_MS` | `8000` | Defuddle parse timeout before sync fallback. |
| `READ_PAGE_DEFUDDLE_ASYNC` | unset | Set to `1` to allow Defuddle third-party async extraction. |
| `READ_PAGE_DEFUDDLE_DEBUG` | unset | Set to `1` to include Defuddle debug information. |

## Development

Install dependencies:

```bash
bun install
```

Run deterministic checks:

```bash
bun run lint
bun test
```

Run the browser integration test:

```bash
bun run integration -- https://example.com
```

The integration test opens a real browser, extracts the page, prints extraction metadata, and closes the browser context.

## Publishing

Pi package catalog entries are discovered from public npm packages with the `pi-package` keyword.

Before publishing:

```bash
bun run lint
bun test
npm pack --dry-run
```

Publish:

```bash
npm login
npm publish --access public
```

After publishing, install with:

```bash
pi install npm:pi-read-page
```

## Project layout

```text
extensions/pi-read-page.ts      extension entrypoint
src/tools/read-page.ts          tool orchestration, output formatting, TUI rendering
src/browser/                    browser lifecycle, extraction, handoff, confidence
src/cache/cache.ts              cache, pagination, checksums
src/security/url-policy.ts      URL normalization and private-network policy
test/                           deterministic unit tests
scripts/integration-read-page.ts browser integration runner
```

## Troubleshooting

### Chrome is not found

Install Google Chrome/Chromium, or set:

```bash
READ_PAGE_CHROME_PATH=/path/to/chrome pi
```

### Login state is missing

By default the extension uses a persistent profile at:

```text
~/.pi/agent/read-page/browser-profile
```

If that profile is already locked by another browser process, `read-page` falls back to a temporary profile. The tool output will include a warning when this happens.

### Query parameters were removed

Set `preserveQuery: true` when query parameters are required for the page content, such as search results, filters, or app/detail pages.

### Localhost or private IP is blocked

This is intentional. Use `READ_PAGE_ALLOW_PRIVATE_NETWORK=1` only when you explicitly want to read local/private services.

## License

MIT. See [LICENSE](LICENSE).
