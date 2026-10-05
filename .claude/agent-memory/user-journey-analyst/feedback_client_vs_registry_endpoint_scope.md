---
name: feedback_client_vs_registry_endpoint_scope
description: Don't let End User client-side journeys silently call new backend endpoints they don't actually call — verify against the real client code
metadata:
  type: feedback
---

On XCOD-34 (registry API), the advisor caught before I wrote anything that the natural-seeming
journey ("user searches, therefore CLI calls `GET /plugins/search?q=`") was wrong. I had grounding
that would have supported it (the spec explicitly parallels registry search to client search), but the
actual client code (`packages/opencode/src/plugin/discover.ts` `searchPlugins`) filters a
already-fetched/cached manifest **entirely client-side** — it never issues a second network call to a
search-specific endpoint. Only `marketplace add` (XCOD-10) and manifest refresh (XCOD-13 caching) touch
the network, and both only ever hit the one "give me the full manifest" endpoint
(`GET /marketplace.json` here), never the registry-native flattened endpoints
(`/marketplaces`, `/plugins`, `/plugins/search`) — those exist for _future_ tooling, not the shipped
client.

**Why:** it's easy to assume symmetry between a backend's endpoint list and a client's UX actions
(one action → one matching endpoint). That assumption is often false when a client has its own local
cache/filter layer. Writing the wrong call chain into a journey doc would propagate into Phase 3
contracts and Phase 4 implementation as invented client-side work that isn't actually needed.

**How to apply:** before writing any End User journey that claims "user does X, which calls endpoint
Y," open the actual client source (not just the API spec) and trace the real call chain. Grounding
must come from code, not from the symmetry the spec's prose implies. See
[[project_xcod32_marketplace_registry_epic]].
