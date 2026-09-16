---
name: project-lunos-web-prerender
description: Angular 22 build-time prerendering setup discovered in Task 11 — angular.json's "prerender" key is dead once "outputMode" is set; render mode is actually controlled by app.routes.server.ts.
metadata:
  type: project
---

In `Lunos.Web/angular.json`, the `build` target's `"prerender"` option (`true` or `{ discoverRoutes, routesFile }`) is **silently ignored** once `"outputMode"` is also set (`"static"` or `"server"`) — `ng build` prints `The "prerender" option is not considered when "outputMode" is specified.` and does not fail. Per-route render mode is actually decided by `src/app/app.routes.server.ts`'s `ServerRoute[]` array (`RenderMode.Prerender` / `.Server` / `.Client`), which `provideServerRendering(withRoutes(serverRoutes))` in `app.config.server.ts` wires in.

**Why:** verified directly — set `"prerender": true` in angular.json, got the warning above, then removed the key and rebuilt; output was byte-identical (`Prerendered 10 static routes.` both times). Confirmed in `node_modules/@angular/build/src/builders/application/options.js` that `server` (a build-time bootstrap entry, e.g. `src/main.server.ts`) is required whenever `prerender`/`ssr`/`app-shell` is used, regardless of `outputMode`.

**How to apply:** when adding/removing prerendered routes in future tasks (e.g. Phase 2 marketplace routes should stay client-rendered), edit `app.routes.server.ts`'s explicit path list, not `angular.json`. Don't bother setting `angular.json`'s `"prerender"` key at all — it does nothing once `outputMode` is present. `outputMode: "static"` + no `ssr` key + a `server` entry point is the correct config for build-time-only prerendering (no live Node SSR server), per PRD §8.

Also: `dist/Lunos.Web/browser/index.html` is no longer a generic CSR shell once prerendering is enabled — it's the prerendered content for whichever route maps to `/`. The actual empty CSR shell (for routes marked `RenderMode.Client`, including the wildcard 404 and any future non-prerendered route) is `dist/Lunos.Web/browser/index.csr.html`. Any IIS/deploy SPA-fallback rule (Task 10, still not done as of Task 11) must point at `index.csr.html`, not `index.html`.

See also [[project_lunos_web_contrast_tokens]].
