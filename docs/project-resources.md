# Project resources

Project resources are specs, docs, folders, repositories, web pages and MCP resources you attach to
a project once. Every session in that project then has them as context, so you don't attach them
by hand each time. For now a project is the repository you're in.

## Adding resources

```sh
lunos resource add spec docs/payments-api.md --mode always --description "Payments API spec"
lunos resource add design ./design --exclude "**/*.sketch"
lunos resource add handbook https://handbook.example.com --depth 1
lunos resource add billing git@github.com:acme/billing.git --branch main
lunos resource add epic "jira://epic/PAY-12" --server jira --mode on_demand
lunos resource add notes ~/notes/payments --personal

lunos resource list            # mode, scope, size and "indexed 2 h ago · 143 chunks"
lunos resource refresh [name]  # index again now
lunos resource remove design
```

Every command takes `--json`. The name is also the resource's `@alias` in prompts.

- **Shared** resources are the default. They're written to the project's `opencode.json` (or
  `opencode.jsonc`) under `resources.entries`, so a teammate who opens the repository gets them. A
  shared file or folder must be inside the repository: a repository's config can't make Lunos read
  `~/.aws` into a prompt.
- **Personal** resources (`--personal`) are kept on this computer, for this project only. They can
  point anywhere.
- Entries in your global config apply to every project on this computer.
- `references` entries show up as on-demand resources too.

## How they reach the agent

| Mode                   | What it does                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `always`               | Included in every session's system prompt, in full. All Always resources together get a budget of 8,000 tokens (`resources.always_tokens`). Adding one that would go over it is refused, with a suggestion to use `search` instead.                 |
| `search` (the default) | Indexed on this computer. The agent sees the list of resources with their descriptions, and calls `project_resources_search` to pull in only the passages it needs. Each passage says which resource and which file and line, or URL, it came from. |
| `on_demand`            | Never added automatically. Mention it as `@name` in a prompt to include it for that turn.                                                                                                                                                           |

The index is a keyword index (BM25) built on this computer. Nothing is sent anywhere to build it.
Content leaves the computer only inside a prompt to the model you chose.

Images (PNG, JPG) are attached when you mention them, for models that accept images. PDF and docx
files can't be converted to text yet: a PDF is attached when you mention it, for models that read
PDFs, and docx files are skipped with a message. Export them as Markdown to search them.

## What never gets in

- `.env*`, `*.pem`, `*.key`, SSH keys (`id_rsa*`, `id_ed25519*`, ...), keystores, `.npmrc`, `.netrc`,
  `credentials*` and `*.tfstate` files, and `.git`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker` and
  `node_modules` folders are skipped without being read.
- Links inside a folder that point outside it are not followed.
- Everything that is read goes through the same credential scanner as the audit log. Anything shaped
  like a key, token or password is masked before it is indexed or sent.

## Trust

Resource content is labelled in the agent's context as reference material, not instructions. Web
pages, MCP resources, repositories and folders outside the project are also marked **untrusted**,
like imported memory, and the content can't close the label early. A turn that used
`project_resources_search` can't write to memory.

## Web pages and repositories

A web resource fetches the page and, with `--depth 1` or `2`, the pages on the same site it links
to: at most 50 pages, 5 MB a page, with a timeout on each request. A redirect to another site is not
followed. Before each page and each redirect, Lunos checks that:

- offline mode (`LUNOS_OFFLINE`) is off;
- `resources.web` isn't `false`;
- no `permission.webfetch` rule denies the URL.

A refused URL is refused with the reason. The residency policy covers model providers, not web
hosts, so it doesn't decide which pages may be fetched. To restrict hosts, use `permission.webfetch`
rules, which an organisation can lock.

Repositories are cloned into the same checkout cache `references` use.

## Staying current

- Files and folders are indexed again when the file watcher reports a change under them. Folders the
  watcher doesn't cover are checked for changes (sizes and times) at most every 30 seconds.
- Web pages, repositories and MCP resources refresh every `resources.refresh_hours` (24 by default),
  or with `lunos resource refresh`.

## Limits

| Key                         | Default | What it limits                               |
| --------------------------- | ------- | -------------------------------------------- |
| `resources.always_tokens`   | 8000    | Tokens all Always resources may add per turn |
| `resources.max_resource_mb` | 50      | Size of one resource                         |
| `resources.max_index_mb`    | 1024    | Size of the project's index on this computer |
| `resources.refresh_hours`   | 24      | How often web, git and MCP resources refresh |
| `resources.web`             | true    | Whether web page resources are allowed       |

## Seeing what's in context

- The sidebar's **Context** section lists the project's resources with their mode, tokens and when
  each was indexed, for example "Resources: 3 always (6.1k tokens) · 5 searchable". Click a resource
  to leave it out of this session, and click again to put it back.
- `/context` shows the last turn's context with its tokens: the system prompt, instructions, Always
  resources, recalled memory, attachments, searched resources and `@mentioned` ones. Press Enter on a
  resource to leave it out of this session.

## Organisations

Resources in managed config are your organisation's: they appear for everyone, read-only. With
`"$locked": ["resources"]`, managed config decides the whole list. Members can't add or remove
resources, and personal ones are off. `"resources": { "web": false }` turns off web resources.

```json
{
  "resources": {
    "entries": {
      "handbook": { "url": "https://handbook.example.com", "depth": 1, "description": "Engineering handbook" }
    },
    "web": true
  },
  "$locked": ["resources"]
}
```
