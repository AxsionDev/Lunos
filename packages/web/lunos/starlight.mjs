// XCOD-124: Lunos's changes to upstream's Starlight options. astro.config.mjs imports this
// module's default export as `starlight`, so that file differs from upstream by one import line.
import upstream from "@astrojs/starlight"
import config from "./config.mjs"

import { EXCLUDED_PAGES } from "./excluded.mjs"

const EXCLUDED = new Set(EXCLUDED_PAGES)

function filterSidebar(items) {
  return items
    .filter((item) => !(typeof item === "string" && EXCLUDED.has(item)))
    .map((item) => (typeof item === "object" && item.items ? { ...item, items: filterSidebar(item.items) } : item))
}

/** @param {Record<string, any>} options upstream's starlight() options */
export function lunosStarlight(options) {
  return {
    ...options,
    title: "Lunos",
    // English only until each locale is rebranded (XCOD-124).
    locales: { root: options.locales.root },
    social: [{ icon: "github", label: "GitHub", href: config.github }],
    logo: { light: "./lunos/assets/logo-light.svg", dark: "./lunos/assets/logo-dark.svg", replacesTitle: true },
    favicon: "/lunos/favicon.svg",
    // Upstream's head only adds opencode's favicons.
    head: [],
    // Upstream's PageFrame adds an "OpenCode v2 is now available" banner linking to opencode.ai;
    // Starlight's own PageFrame has no banner. lunos.css removes the space reserved for it.
    components: (({ PageFrame, ...rest }) => ({ ...rest, Head: "./lunos/Head.astro" }))(options.components ?? {}),
    customCss: [...(options.customCss ?? []), "./lunos/lunos.css"],
    editLink: { baseUrl: `${config.github}/edit/dev/packages/web/` },
    sidebar: [
      ...filterSidebar(options.sidebar),
      {
        label: "Lunos",
        items: ["lunos-fork", "data-residency", "offline-mode", "marketplace", "memory", "artifacts", "models-tested", "trust"],
      },
    ],
  }
}

/** Drop-in for `@astrojs/starlight`'s default export. */
export default function starlight(options) {
  return upstream(lunosStarlight(options))
}
