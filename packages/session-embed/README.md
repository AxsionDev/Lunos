# @lunos/session-embed

A self-contained Vite library build of the session timeline (`SessionTurn` from `@opencode-ai/session-ui`, with the providers it needs). `lunoshq/app` vendors this package's `dist/` and loads it at runtime to show a synced session read-only.

```ts
const { mount } = await import("/vendor/session-embed/session-embed.js")
const dispose = mount(el, { session: { id, title }, messages: [{ info, parts }, ...] })
```

`mount` renders one `SessionTurn` per user message (edit and shell tools collapsed) and returns a dispose function. `toData` in `src/data.ts` converts the session and messages into the shape `DataProvider` expects.

## Build

```sh
bun install
cd packages/session-embed
bun run build       # vite build
bun test            # unit tests
bun typecheck
```

Output in `dist/`:

- `session-embed.js` (ES module, solid bundled in)
- `session-embed.css` (name is pinned so a host can link it)
- `assets/*` (lazy syntax-highlighting grammars and workers, resolved relative to the module)

Vendor all of `dist/` together; the module loads `assets/*` relative to itself.

Sizes at XCOD-185 (minified / gzip):

| File | Size | gzip |
|---|---|---|
| `session-embed.js` | 2.86 MB | 705 kB |
| `session-embed.css` | 1.74 MB | 985 kB |
| `assets/*` (609 files, lazy) | 20 MB | n/a |

Most of the CSS is base64 fonts inlined by `@opencode-ai/ui`; the rules themselves are about 307 kB (370 kB before Tailwind's scan was narrowed to `session-ui` and `ui`).

## Smoke test

`test/smoke.ts` serves `dist/` plus a fixture page from a temp directory, mounts a small session in headless chromium, and asserts that user text, assistant text and a tool row render with no console errors. Run it by hand after building:

```sh
bun test/smoke.ts
```

It uses the Playwright chromium build if installed, otherwise a cached `chromium_headless_shell-*` under `~/Library/Caches/ms-playwright`.

## Licence

MIT. Upstream opencode plus ITService EOOD.
