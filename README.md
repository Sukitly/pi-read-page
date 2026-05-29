# pi-web-read

Browser-backed `web_read(url)` extension for pi.

Goal: make web reading feel like `read_url`, but fall back to a real local browser when pages need JavaScript, login state, captcha handling, or manual navigation.

## Contract

Only one Agent-facing tool is exposed:

```text
web_read(url, offset?, limit?, refresh?, preserveQuery?)
```

Default usage still only needs a URL:

```text
web_read({ url: "https://example.com" })
```

It is read-only by capability design:

- Agent only provides a URL and pagination/cache options.
- The extension does not expose click/type/submit/eval tools.
- If user action is required, the tool opens a headed browser and waits for user confirmation in pi.
- After confirmation, the tool extracts the current browser page and returns paginated Markdown.

## Tool behavior

- `offset`: 1-based line offset. Defaults to `1`.
- `limit`: number of lines. Defaults to `300`, max `1000`.
- `refresh`: force browser re-extraction and overwrite cache. Defaults to `false`.
- `preserveQuery`: keep URL query params. Defaults to `false`.

Cache:

- Successful browser extractions are cached at `~/.pi/agent/caches/web-read`.
- Normal TTL: 30 days.
- User-action TTL: 1 day.
- Cache files: `content.md` + `meta.json`.
- Writes are atomic and content is sha256-verified on load.
- If refresh/extraction fails and cache exists, cached content is returned with an accurate `refresh-failed-fresh` or `stale-fallback` warning.

## Extraction pipeline

The production extraction core follows Obsidian Web Clipper's approach:

```text
Playwright headed browser
  -> request-level private-network policy
  -> wait for DOM + network idle
  -> final URL private-network policy
  -> read-only lazy scroll
  -> flatten open shadow roots into data-defuddle-shadow
  -> absolutize src/href/srcset for extraction
  -> Defuddle extraction with Markdown output
  -> confidence assessment
  -> optional user handoff via ctx.ui.confirm
  -> cache full Markdown
  -> return requested line page
```

Default privacy stance:

- `WEB_READ_DEFUDDLE_ASYNC` defaults to off.
- Defuddle third-party async fallback is only enabled with `WEB_READ_DEFUDDLE_ASYNC=1`.
- Private/local hosts and IPs are refused by default. Use `WEB_READ_ALLOW_PRIVATE_NETWORK=1` only when intentionally reading local services.

## Development

```bash
cd /Users/sukit/Codes/open-source/pi-web-read
bun install
pi -e .
```

Smoke test without pi:

```bash
bun run smoke -- https://example.com
```

## Environment

Optional:

```bash
WEB_READ_CHROME_PATH=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
WEB_READ_BROWSER_CHANNEL=chrome
WEB_READ_PROFILE_DIR=~/.pi/agent/web-read/browser-profile
WEB_READ_PARSE_TIMEOUT_MS=8000
WEB_READ_DEFUDDLE_DEBUG=1
WEB_READ_DEFUDDLE_ASYNC=1
WEB_READ_DISABLE_TEMP_PROFILE_FALLBACK=1
WEB_READ_ALLOW_PRIVATE_NETWORK=1
```

Defaults:

- headed browser
- persistent browser profile at `~/.pi/agent/web-read/browser-profile`
- browser channel `chrome`
- temporary profile fallback if the persistent profile is already locked

## Status

Production extraction core, cache, pagination, stale fallback, URL policy, TUI rendering, browser cleanup, and pure unit tests implemented.
