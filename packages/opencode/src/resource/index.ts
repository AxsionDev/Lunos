import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Offline } from "@opencode-ai/core/offline"
import { Reference } from "@opencode-ai/core/reference"
import { Repository } from "@opencode-ai/core/repository"
import { RepositoryCache } from "@opencode-ai/core/repository-cache"
import { AbsolutePath } from "@opencode-ai/core/schema"
import type { ConfigResource } from "@opencode-ai/core/config/resource"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import type { EventV2 } from "@opencode-ai/core/event"
import { Cause, Context, Duration, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Token } from "@/util/token"
import { ResourceCore } from "./resource"
import { ResourceFetch } from "./fetch"
import { ResourceScope } from "./scope"
import { ResourceSearch } from "./search"

/**
 * Project resources (XCOD-300) for the live session path: the system prompt's Always block and
 * resource list, the `project_resources_search` tool, `@name` mentions, and what /context and the
 * sidebar show. Content is read on this computer and kept in an index under the data directory;
 * it leaves only inside a prompt to the model the user chose.
 *
 * - Web pages and repositories are fetched only if offline mode is off, `resources.web` allows web
 *   pages, and no `permission.webfetch` rule denies the URL (checked for every page and redirect).
 *   The residency policy governs model providers, not web hosts, so it isn't consulted here.
 * - Local resources are re-indexed when the file watcher reports a change under them, and checked
 *   for changes (sizes and times) at most every 30 seconds otherwise, for folders the watcher
 *   doesn't cover. Web, git and MCP resources refresh every `resources.refresh_hours`.
 */

export type Entry = ResourceCore.Resource & {
  status?: ResourceCore.Status
  state: string
  excluded: boolean
}

export interface Breakdown {
  time: number
  system: number
  instructions: number
  always: number
  memory: number
  attachments: number
  searched: number
  mentioned: number
  resources: ResourceCore.Included[]
  dropped: ResourceCore.Always["dropped"]
}

export type Part = { type: "text"; text: string } | { type: "file"; mime: string; url: string; filename: string }

export class ResourceError extends Error {
  override name = "ResourceError"
}

export interface Interface {
  readonly list: (sessionID?: string) => Effect.Effect<Entry[]>
  readonly system: (sessionID: string) => Effect.Effect<{ catalog?: string; always: ResourceCore.Always }>
  readonly searchable: (sessionID: string) => Effect.Effect<boolean>
  readonly search: (input: {
    query: string
    sessionID: string
    limit?: number
    resources?: readonly string[]
  }) => Effect.Effect<{ text: string; count: number; tokens: number }>
  readonly mention: (input: {
    sessionID: string
    text: string
    image: boolean
    pdf: boolean
  }) => Effect.Effect<{ parts: Part[]; tokens: number; names: string[] }>
  readonly exclude: (sessionID: string, name: string, excluded: boolean) => Effect.Effect<void>
  readonly refresh: (name?: string) => Effect.Effect<Entry[]>
  /** Refreshes what is due. Runs hourly; exposed so tests can drive it with their own clock. */
  readonly tick: (now?: number) => Effect.Effect<string[]>
  readonly add: (input: {
    name: string
    entry: ConfigResource.Entry
    scope: "shared" | "personal"
  }) => Effect.Effect<Entry, ResourceError>
  readonly remove: (name: string) => Effect.Effect<ResourceCore.Scope, ResourceError>
  readonly record: (sessionID: string, breakdown: Omit<Breakdown, "time">) => Effect.Effect<void>
  readonly turn: (sessionID: string) => Effect.Effect<Breakdown | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Resource") {}

const CHECK_MS = 30_000

interface State {
  scope: ResourceScope.Scope
  store: ResourceCore.Store
  directory: string
  excluded: Map<string, Set<string>>
  turns: Map<string, Breakdown>
  /** Local resources the watcher saw change. */
  dirty: Set<string>
  checked: Map<string, number>
  /** Loaded index entries, by name. */
  cache: Map<string, ResourceCore.Stored>
  search?: { key: string; index: ResourceSearch.Index }
  managed?: Promise<unknown[]>
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const events = yield* EventV2Bridge.Service
    const locations = yield* LocationServiceMap.Service
    const repositories = yield* RepositoryCache.Service

    const inLocation = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("Resource.state")(function* (ctx) {
        const scope = ResourceScope.resourceScope(ctx)
        const data: State = {
          scope,
          store: new ResourceCore.Store(Global.Path.data, scope.id),
          directory: ctx.directory,
          excluded: new Map(),
          turns: new Map(),
          dirty: new Set(),
          checked: new Map(),
          cache: new Map(),
        }
        const unsubscribe = yield* events.listen((event) => {
          if (event.type !== Watcher.Event.Updated.type) return Effect.void
          const file = (event.data as EventV2.Data<typeof Watcher.Event.Updated>).file
          return Effect.sync(() => {
            for (const [name, stored] of data.cache)
              if (stored.docs.some((doc) => doc.file?.path === file) || targets.get(name)?.(file)) data.dirty.add(name)
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)
        // Web, git and MCP resources refresh on their schedule (resources.refresh_hours), checked hourly.
        yield* Effect.sleep(Duration.hours(1)).pipe(
          Effect.andThen(tick().pipe(Effect.ignore)),
          Effect.forever,
          Effect.forkScoped,
        )
        return data
      }),
    )

    /** For each loaded local resource, whether a changed file is under it. */
    const targets = new Map<string, (file: string) => boolean>()

    const resolved = Effect.fn("Resource.resolved")(function* () {
      const data = yield* InstanceState.get(state)
      const cfg = yield* config.get()
      const personal = yield* Effect.promise(() =>
        data.store.personal().catch(() => ({}) as Record<string, ConfigResource.Entry>),
      )
      const managed = yield* Effect.promise(
        () => (data.managed ??= ConfigManaged.readManagedDocs().catch(() => [] as unknown[])),
      )
      const shared = yield* Effect.promise(() =>
        ResourceCore.sharedNames([...new Set([data.scope.directory, data.directory])]),
      )
      const references = yield* inLocation(
        data.directory,
        Effect.gen(function* () {
          return yield* (yield* Reference.Service).list()
        }),
      ).pipe(Effect.orElseSucceed(() => [] as Reference.Info[]))
      const list = ResourceCore.resolve({
        config: cfg.resources,
        locked: cfg.$locked,
        directory: data.scope.directory,
        shared,
        personal,
        managed,
        references: references.map((item) => ({
          name: item.name,
          path: item.path,
          description: item.description,
          hidden: item.hidden,
          git: item.source.type === "git" ? item.source.repository : undefined,
        })),
      })
      return { data, cfg, list }
    })

    type Cfg = Effect.Success<ReturnType<typeof config.get>>

    const limits = (cfg: Cfg) => ({
      alwaysTokens: cfg.resources?.always_tokens ?? ResourceCore.DEFAULTS.alwaysTokens,
      maxBytes: (cfg.resources?.max_resource_mb ?? ResourceCore.DEFAULTS.maxResourceMb) * 1024 * 1024,
      maxIndexBytes: (cfg.resources?.max_index_mb ?? ResourceCore.DEFAULTS.maxIndexMb) * 1024 * 1024,
      refreshHours: cfg.resources?.refresh_hours ?? ResourceCore.DEFAULTS.refreshHours,
    })

    /** Why a URL may not be fetched, if it may not. */
    const gate = (cfg: Cfg) => {
      const rules = Permission.fromConfig(cfg.permission ?? {})
      return (url: string) => {
        if (Offline.enabled()) return Offline.message("Fetching web and git resources")
        const rule = Permission.evaluate("webfetch", url, rules)
        if (rule.action === "deny")
          return `permission.webfetch denies ${url}${rule.pattern !== "*" ? ` (rule "${rule.pattern}")` : ""}`
      }
    }

    const load = Effect.fn("Resource.load")(function* (resource: ResourceCore.Resource, cfg: Cfg) {
      const limit = limits(cfg)
      const entry = resource.entry
      if (resource.kind === "reference")
        return yield* Effect.promise(() => ResourceFetch.local(resource.target, { maxBytes: limit.maxBytes }))
      if (!entry) throw new ResourceError(`${resource.name} has no config`)
      if ("path" in entry)
        return yield* Effect.promise(() =>
          ResourceFetch.local(resource.target, {
            maxBytes: limit.maxBytes,
            include: entry.include,
            exclude: entry.exclude,
          }),
        )
      if ("url" in entry)
        return yield* Effect.promise(() =>
          ResourceFetch.web(entry.url, { depth: entry.depth ?? 0, gate: gate(cfg), maxBytes: limit.maxBytes }),
        )
      if ("repository" in entry) {
        const refusal = gate(cfg)(entry.repository)
        if (refusal) throw new ResourceFetch.RefusedError(refusal)
        const reference = Repository.parse(entry.repository)
        if (!reference || !Repository.isRemote(reference))
          throw new ResourceError(`${entry.repository} isn't a git repository URL`)
        // The same checkout cache `references` use (core/reference.ts).
        const checkout = yield* repositories
          .ensure({ reference, branch: entry.branch, refresh: true })
          .pipe(Effect.timeout(Duration.minutes(5)))
        return yield* Effect.promise(() =>
          ResourceFetch.local(checkout.localPath, {
            maxBytes: limit.maxBytes,
            include: entry.include,
            exclude: entry.exclude,
          }),
        )
      }
      const result = yield* mcp.readResource(entry.server, entry.uri).pipe(Effect.timeout(Duration.seconds(60)))
      if (!result)
        throw new ResourceError(`MCP server "${entry.server}" isn't connected or has no resource ${entry.uri}`)
      return ResourceFetch.mcp(result.contents as ResourceFetch.McpContent[], { maxBytes: limit.maxBytes })
    })

    /** Reads and stores one resource now. A failure is stored too, so status can say what went wrong. */
    const index = Effect.fn("Resource.index")(function* (
      data: State,
      cfg: Cfg,
      resource: ResourceCore.Resource,
      now = Date.now(),
    ) {
      const limit = limits(cfg)
      const next = yield* Effect.gen(function* () {
        const loaded = yield* load(resource, cfg)
        const signature =
          resource.kind === "path"
            ? yield* Effect.promise(() => ResourceFetch.stamp(resource.target, globsOf(resource)))
            : undefined
        const built = ResourceCore.stored(resource, loaded, now, signature ? { signature } : {})
        const others = yield* Effect.promise(() => data.store.size(resource.name))
        if (others + JSON.stringify(built).length > limit.maxIndexBytes)
          throw new ResourceError(
            `the project's resource index would pass ${Math.round(limit.maxIndexBytes / 1024 / 1024)} MB (resources.max_index_mb)`,
          )
        return built
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            ResourceCore.stored(resource, { docs: [], skipped: [], bytes: 0, redacted: 0 }, now, {
              error: message(Cause.squash(cause)),
            }),
          ),
        ),
      )
      yield* Effect.promise(() => data.store.write(next))
      data.cache.set(resource.name, next)
      data.checked.set(resource.name, now)
      data.dirty.delete(resource.name)
      data.search = undefined
      if (resource.kind === "path") targets.set(resource.name, under(resource.target))
      return next
    })

    const stored = Effect.fn("Resource.stored")(function* (data: State, name: string) {
      const hit = data.cache.get(name)
      if (hit) return hit
      const read = yield* Effect.promise(() => data.store.read(name))
      if (read) data.cache.set(name, read)
      return read
    })

    /**
     * The resource's index, (re)built first if it is missing, its config changed, a local file
     * changed, or a remote one is due. `wait: false` refreshes a stale remote one in the background.
     */
    const ensure = Effect.fn("Resource.ensure")(function* (
      data: State,
      cfg: Cfg,
      resource: ResourceCore.Resource,
      wait = true,
    ) {
      const now = Date.now()
      const current = yield* stored(data, resource.name)
      if (current && resource.kind === "path") targets.set(resource.name, under(resource.target))
      if (!current || current.status.fingerprint !== ResourceCore.fingerprint(resource.entry, resource.target))
        return yield* index(data, cfg, resource)
      if (resource.kind === "path") {
        const last = data.checked.get(resource.name) ?? 0
        if (data.dirty.has(resource.name) || now - last >= CHECK_MS) {
          data.checked.set(resource.name, now)
          const signature = yield* Effect.promise(() => ResourceFetch.stamp(resource.target, globsOf(resource)))
          if (data.dirty.has(resource.name) || signature !== current.status.signature)
            return yield* index(data, cfg, resource)
        }
        return current
      }
      if (resource.kind !== "reference" && ResourceCore.due(resource, current.status, now, limits(cfg).refreshHours)) {
        if (wait) return yield* index(data, cfg, resource)
        yield* index(data, cfg, resource).pipe(Effect.ignore, Effect.forkDetach)
      }
      return current
    })

    const visible = (data: State, sessionID: string | undefined, list: ResourceCore.Resource[]) => {
      const off = sessionID ? data.excluded.get(sessionID) : undefined
      return list.filter((item) => !item.problem && !off?.has(item.name))
    }

    const entries = Effect.fn("Resource.entries")(function* (sessionID?: string) {
      const { data, list } = yield* resolved()
      const now = Date.now()
      const off = sessionID ? data.excluded.get(sessionID) : undefined
      return yield* Effect.forEach(list, (resource) =>
        Effect.gen(function* () {
          const status = (yield* stored(data, resource.name))?.status
          return {
            ...resource,
            status,
            state: resource.problem ?? ResourceCore.describe(status, now),
            excluded: !!off?.has(resource.name),
          } satisfies Entry
        }),
      )
    })

    const system = Effect.fn("Resource.system")(function* (sessionID: string) {
      const { data, cfg, list } = yield* resolved()
      const usable = visible(data, sessionID, list)
      const items = yield* Effect.forEach(
        usable.filter((item) => item.mode === "always"),
        (resource) =>
          ensure(data, cfg, resource, false).pipe(
            Effect.map((stored) => ({ resource, stored })),
            Effect.orElseSucceed(() => ({ resource, stored: undefined })),
          ),
      )
      const always = ResourceCore.always(items, limits(cfg).alwaysTokens)
      return { catalog: ResourceCore.catalog(usable, true), always }
    })

    const searchable = Effect.fn("Resource.searchable")(function* (sessionID: string) {
      const { data, list } = yield* resolved()
      return visible(data, sessionID, list).some((item) => item.mode === "search")
    })

    const search = Effect.fn("Resource.search")(function* (input: {
      query: string
      sessionID: string
      limit?: number
      resources?: readonly string[]
    }) {
      const { data, cfg, list } = yield* resolved()
      const usable = visible(data, input.sessionID, list).filter(
        (item) => item.mode === "search" && (!input.resources?.length || input.resources.includes(item.name)),
      )
      const indexes = yield* Effect.forEach(usable, (resource) => ensure(data, cfg, resource), { concurrency: 4 })
      const key = indexes.map((item) => `${item.name}@${item.status.indexedAt}`).join("|")
      if (data.search?.key !== key)
        data.search = { key, index: ResourceSearch.bm25(indexes.flatMap((item) => ResourceCore.chunks(item))) }
      const hits = data.search.index.search(input.query, Math.min(Math.max(1, input.limit ?? 5), 10))
      const byName = new Map(usable.map((item) => [item.name, item]))
      const failed = indexes.filter((item) => item.status.error).map((item) => `${item.name}: ${item.status.error}`)
      const out = ResourceCore.results(hits, byName)
      return {
        ...out,
        text: [out.text, ...failed.map((line) => `(Couldn't search ${line})`)].filter(Boolean).join("\n\n"),
      }
    })

    const mention = Effect.fn("Resource.mention")(function* (input: {
      sessionID: string
      text: string
      image: boolean
      pdf: boolean
    }) {
      const { data, cfg, list } = yield* resolved()
      // References already become folder attachments when picked from the @ menu.
      const usable = list.filter((item) => !item.problem && item.kind !== "reference")
      const names = ResourceCore.mentions(input.text, new Set(usable.map((item) => item.name)))
      const parts: Part[] = []
      let tokens = 0
      for (const name of names) {
        const resource = usable.find((item) => item.name === name)!
        const store = yield* ensure(data, cfg, resource)
        if (store.status.error) {
          parts.push({ type: "text", text: `(@${name} couldn't be read: ${store.status.error})` })
          continue
        }
        if (ResourceCore.fullText(store.docs)) {
          const text = ResourceCore.mention(resource, store, limits(cfg).alwaysTokens)
          tokens += Token.estimate(text)
          parts.push({ type: "text", text })
        }
        for (const doc of store.docs) {
          if (!doc.file) continue
          const accepted = doc.file.mime === "application/pdf" ? input.pdf : input.image
          if (!accepted) {
            parts.push({
              type: "text",
              text: `(${doc.source} from @${name} isn't attached: this model doesn't accept ${doc.file.mime === "application/pdf" ? "PDF files" : "images"})`,
            })
            continue
          }
          const base64 =
            doc.file.data ??
            (doc.file.path
              ? Buffer.from(yield* Effect.promise(() => Bun.file(doc.file!.path!).arrayBuffer())).toString("base64")
              : undefined)
          if (!base64) continue
          parts.push({
            type: "file",
            mime: doc.file.mime,
            url: `data:${doc.file.mime};base64,${base64}`,
            filename: path.basename(doc.source),
          })
        }
      }
      return { parts, tokens, names }
    })

    const refresh = Effect.fn("Resource.refresh")(function* (name?: string) {
      const { data, cfg, list } = yield* resolved()
      const pick = name ? list.filter((item) => item.name === name) : list.filter((item) => item.kind !== "reference")
      yield* Effect.forEach(
        pick.filter((item) => !item.problem),
        (resource) => index(data, cfg, resource),
        { concurrency: 2 },
      )
      return (yield* entries()).filter((item) => !name || item.name === name)
    })

    const tick = Effect.fn("Resource.tick")(function* (now: number = Date.now()) {
      const { data, cfg, list } = yield* resolved()
      const refreshed: string[] = []
      for (const resource of list) {
        if (resource.problem || resource.kind === "path" || resource.kind === "reference") continue
        const current = yield* stored(data, resource.name)
        // Only what was indexed before: a resource nobody has used yet is indexed when it is.
        if (!current || !ResourceCore.due(resource, current.status, now, limits(cfg).refreshHours)) continue
        yield* index(data, cfg, resource, now)
        refreshed.push(resource.name)
      }
      return refreshed
    })

    const add = Effect.fn("Resource.add")(function* (input: {
      name: string
      entry: ConfigResource.Entry
      scope: "shared" | "personal"
    }) {
      const { data, cfg, list } = yield* resolved()
      if (ConfigPolicyLocked(cfg)) return yield* Effect.fail(new ResourceError(LOCKED))
      if (!ResourceCore.NAME.test(input.name))
        return yield* Effect.fail(
          new ResourceError(`the name "${input.name}" can only use letters, digits, ".", "_" and "-"`),
        )
      const existing = list.find((item) => item.name === input.name)
      if (existing)
        return yield* Effect.fail(
          new ResourceError(
            existing.kind === "reference"
              ? `@${input.name} is already a reference (references.${input.name}); pick another name`
              : `there is already a resource named ${input.name} (${existing.scope}); remove it first`,
          ),
        )
      const candidate = ResourceCore.resolve({
        config: { ...cfg.resources, entries: { [input.name]: input.entry } },
        directory: data.scope.directory,
        shared: new Set(input.scope === "shared" ? [input.name] : []),
        personal: {},
        managed: [],
      })[0]!
      if (candidate.problem) return yield* Effect.fail(new ResourceError(candidate.problem))
      const scoped = { ...candidate, scope: input.scope } as ResourceCore.Resource
      const images = scoped.kind === "path" && ResourceCore.isImage(scoped.target)
      if (images && scoped.mode !== "on_demand")
        return yield* Effect.fail(
          new ResourceError("an image is attached when a prompt mentions it, so its mode can only be on_demand"),
        )
      // Index before saving, so an Always resource over the budget is refused before it is added.
      const next = yield* index(data, cfg, scoped)
      if (next.status.error) {
        yield* Effect.promise(() => data.store.remove(input.name))
        data.cache.delete(input.name)
        return yield* Effect.fail(new ResourceError(`couldn't read ${input.name}: ${next.status.error}`))
      }
      if (scoped.mode === "always") {
        const budget = limits(cfg).alwaysTokens
        const current = yield* system("")
        const own = ResourceCore.always([{ resource: scoped, stored: next }], Number.POSITIVE_INFINITY).tokens
        if (current.always.tokens + own > budget) {
          yield* Effect.promise(() => data.store.remove(input.name))
          data.cache.delete(input.name)
          return yield* Effect.fail(
            new ResourceError(
              `${input.name} is about ${own} tokens, and always resources would come to ${current.always.tokens + own}, over the project's budget of ${budget} (resources.always_tokens). Add it with --mode search instead: the agent then pulls in only the parts it needs`,
            ),
          )
        }
      }
      if (input.scope === "personal") yield* Effect.promise(() => data.store.setPersonal(input.name, input.entry))
      else yield* Effect.promise(() => ResourceCore.writeShared(data.scope.directory, input.name, input.entry))
      yield* config.invalidate()
      const after = (yield* entries()).find((item) => item.name === input.name)
      return (
        after ?? {
          ...scoped,
          status: next.status,
          state: ResourceCore.describe(next.status, Date.now()),
          excluded: false,
        }
      )
    })

    const remove = Effect.fn("Resource.remove")(function* (name: string) {
      const { data, cfg, list } = yield* resolved()
      const resource = list.find((item) => item.name === name)
      if (!resource) return yield* Effect.fail(new ResourceError(`there is no resource named ${name}`))
      if (ConfigPolicyLocked(cfg)) return yield* Effect.fail(new ResourceError(LOCKED))
      if (resource.scope === "organisation")
        return yield* Effect.fail(
          new ResourceError(`${name} is your organisation's resource, and only it can remove it`),
        )
      if (resource.kind === "reference")
        return yield* Effect.fail(
          new ResourceError(`${name} is a reference: remove references.${name} from your config instead`),
        )
      if (resource.scope === "user")
        return yield* Effect.fail(
          new ResourceError(`${name} is in your global config (resources.entries.${name}): remove it there`),
        )
      if (resource.scope === "personal") yield* Effect.promise(() => data.store.setPersonal(name, undefined))
      else yield* Effect.promise(() => ResourceCore.writeShared(data.scope.directory, name, undefined))
      yield* Effect.promise(() => data.store.remove(name))
      data.cache.delete(name)
      data.search = undefined
      yield* config.invalidate()
      return resource.scope
    })

    const exclude = Effect.fn("Resource.exclude")(function* (sessionID: string, name: string, excluded: boolean) {
      const data = yield* InstanceState.get(state)
      const set = data.excluded.get(sessionID) ?? new Set<string>()
      if (excluded) set.add(name)
      else set.delete(name)
      data.excluded.set(sessionID, set)
    })

    const record = Effect.fn("Resource.record")(function* (sessionID: string, breakdown: Omit<Breakdown, "time">) {
      const data = yield* InstanceState.get(state)
      data.turns.set(sessionID, { ...breakdown, time: Date.now() })
    })

    const turn = Effect.fn("Resource.turn")(function* (sessionID: string) {
      return (yield* InstanceState.get(state)).turns.get(sessionID)
    })

    return Service.of({
      list: entries,
      system,
      searchable,
      search,
      mention,
      exclude,
      refresh,
      tick,
      add,
      remove,
      record,
      turn,
    })
  }),
)

const LOCKED =
  "your organisation's managed config locks resources ($locked), so they can't be changed here; ask an administrator"

function ConfigPolicyLocked(cfg: { $locked?: readonly string[] }) {
  return !!cfg.$locked?.some((key) => key === "resources" || key.startsWith("resources."))
}

function globsOf(resource: ResourceCore.Resource) {
  const entry = resource.entry
  return entry && ("path" in entry || "repository" in entry) ? entry : undefined
}

function under(target: string) {
  return (file: string) => {
    const relative = path.relative(target, file)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }
}

const locationServiceMapNode = LayerNode.make({
  service: LocationServiceMap.Service,
  layer: locationServiceMapLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, MCP.node, EventV2Bridge.node, RepositoryCache.node, locationServiceMapNode],
})

export * as Resource from "."
