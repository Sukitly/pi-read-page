# pi-read-page

Browser-backed `read-page(url)` extension for pi.

Goal: read webpages with a real local browser when pages need JavaScript, login state, captcha handling, or manual navigation.

## Contract

Only one Agent-facing tool is exposed:

```text
read-page(url, offset?, limit?, refresh?, preserveQuery?)
```

Default usage still only needs a URL:

```text
read-page({ url: "https://example.com" })
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

- Successful browser extractions are cached at `~/.pi/agent/caches/read-page`.
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

- `READ_PAGE_DEFUDDLE_ASYNC` defaults to off.
- Defuddle third-party async fallback is only enabled with `READ_PAGE_DEFUDDLE_ASYNC=1`.
- Private/local hosts and IPs are refused by default. Use `READ_PAGE_ALLOW_PRIVATE_NETWORK=1` only when intentionally reading local services.

## Development

```bash
cd /Users/sukit/Codes/open-source/pi-read-page
bun install
pi -e .
```

Integration test without pi:

```bash
bun run integration -- https://example.com
```

## Environment

Optional:

```bash
READ_PAGE_CHROME_PATH=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
READ_PAGE_BROWSER_CHANNEL=chrome
READ_PAGE_PROFILE_DIR=~/.pi/agent/read-page/browser-profile
READ_PAGE_PARSE_TIMEOUT_MS=8000
READ_PAGE_DEFUDDLE_DEBUG=1
READ_PAGE_DEFUDDLE_ASYNC=1
READ_PAGE_DISABLE_TEMP_PROFILE_FALLBACK=1
READ_PAGE_ALLOW_PRIVATE_NETWORK=1
```

Defaults:

- headed browser
- persistent browser profile at `~/.pi/agent/read-page/browser-profile`
- browser channel `chrome`
- temporary profile fallback if the persistent profile is already locked

## Status

Production extraction core, cache, pagination, stale fallback, URL policy, TUI rendering, browser cleanup, and pure unit tests implemented.
