# Deploying docs.lunos.tech (XCOD-124)

The Lunos docs are a static site. Axsion hosts them on its own servers in the EU; no Cloudflare
account or other third-party host is involved.

## With the lunos-web scripts (recommended)

The docs ship in the same artifact as lunos.tech and its API. In the lunos-web repo:

```powershell
./build.ps1 -LunosRepo <path to this repo>   # builds web, api and docs (needs bun)
./deploy.ps1 -ArtifactZip <zip>              # on the IIS box, as Administrator
```

`build.ps1` runs the same branding check as CI. `deploy.ps1` mirrors the docs to the docs IIS site
and checks the version and search afterwards. The IIS config (`docs-site/web.config`) and the
one-time site setup (technical spec §9) live in lunos-web. The rest of this page is for serving the
docs some other way.

## Get a build

- **From CI:** every push to `dev` runs the `docs-lunos` workflow, which uploads the built site as
  the `lunos-docs` artifact (Actions → docs-lunos → latest run → Artifacts). It has passed the
  branding check.
- **Locally:** `bun install`, then `cd packages/web && bun run build && bun lunos/check-built.ts`.
  The site is in `packages/web/dist/docs/`.

## Serve it

Copy the contents of `dist/docs/` to the web root under `docs/`, so pages are served at
`https://docs.lunos.tech/docs/…` (the site is built with base path `/docs`). Only static files are
needed: the Cloudflare worker (`dist/_worker.js`) serves upstream's share viewer and raw-markdown
endpoints, which Lunos doesn't use, so don't deploy it.

Example nginx server block:

```nginx
server {
    server_name docs.lunos.tech;
    root /var/www/docs.lunos.tech;          # contains docs/

    location = / { return 302 /docs/; }
    location /docs/ {
        try_files $uri $uri/ =404;
        error_page 404 /docs/404.html;
    }
    location /docs/_astro/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

Checked 2026-09-27 by serving `dist/docs` from a plain static file server: pages, `_astro` assets,
search (`pagefind`), favicon and social card return 200, and unknown pages 404.

## After deploying

Record the hosting provider and region on XCOD-124, then run the install commands from the
Intro page on a clean machine (the ticket's copy-paste acceptance check).
