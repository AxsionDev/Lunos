# Where memory is stored

When you set up memory (`lunos memory setup`, or **/settings → Memory → Set up memory…** in the TUI), step 2 asks **"Where should memory be stored?"**. You can start from a [template](memory-templates.md), or choose the storage yourself. Each option has a **What this means** panel. It's shown when you highlight the option in the TUI, and printed under the option in the CLI. The panel uses this machine's real memory path, model and region.

The same words appear everywhere memory storage is shown: the wizard and its summary, `lunos memory status`, `lunos memory stats`, the status line, and **/memory → Overview**.

## The options

|                          | On this computer                    | Team database: Neo4j                     | Team database: PostgreSQL                |
| ------------------------ | ----------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Where it's stored        | this computer                       | your Neo4j                               | your PostgreSQL                          |
| What leaves the computer | the fact text, to your model        | the fact text, to the database           | the fact text, to the database           |
| Model calls              | your model, when a fact is saved    | none                                     | none                                     |
| Shared                   | no, only you                        | with your team                           | with your team                           |
| Search type              | meaning (embeddings) and a graph    | keyword (full-text)                      | keyword (full-text)                      |
| Setup needed             | none (~300 MB on first start)       | URL, user, password                      | URL, user, password                      |
| Offline use              | recall yes; saving needs your model | only if the database is on this computer | only if the database is on this computer |

Press **c** on the storage step to see this table in the TUI. The CLI's "Compare" entry prints it too.

### On this computer (recommended for one person)

- **Stored:** in your memory directory on this computer: `.opencode/memory/graph/` in the project for project memory, and the Lunos data directory for user memory. The data is a SQLite file, a LanceDB vector store and a local graph.
- **Leaves the computer:** the fact text. It's sent to your model, under your residency policy, to pull out names and relationships. Search embeddings are made on this computer. With a model that runs on this computer (Ollama, LM Studio), nothing leaves it; see the template _Just me, fully local_.
- **Shared:** no, only you.
- **Needs:** nothing. The first start downloads about 300 MB: the engine's packages and the embedding model.
- **Encryption:** optional. The fact ledger can be encrypted with a key in your OS keychain.

In config this is `"memory": { "backend": { "type": "embedded" } }`, which is also the default. The setting keeps that value; the screens never show it.

### Team database: Neo4j

- **Stored:** one node per fact in your Neo4j.
- **Leaves the computer:** the fact text, to that database only. No model calls.
- **Shared:** with everyone using the same database and scope.
- **Needs:** a Bolt URL, a user and a password. Give the user and password as `{env:…}` or `{file:…}` references.
- **Search:** keyword (full-text), with no relationship graph.

### Team database: PostgreSQL

The same model as Neo4j. The database is the ledger: one row per fact, holding its record, provenance and a SHA-256 of it, kept apart by scope namespace. Search uses PostgreSQL's full-text search (English stemming; a fact matches if it shares any word with the query).

```jsonc
"memory": {
  "enabled": true,
  "encryption": "off",
  "backend": {
    "type": "postgres",
    "url": "postgres://db.internal:5432/lunos",   // TLS with a verified certificate unless the host is this computer
    "username": "{env:POSTGRES_USER}",
    "password": "{env:POSTGRES_PASSWORD}",
    "jurisdiction": "EU-DE"                        // checked against your residency policy before connecting
  }
}
```

- **TLS** is required except to localhost. With no `sslmode` in the URL, Lunos connects with TLS and verifies the certificate. `sslmode=require` or `verify-ca` encrypts without fully verifying, and `lunos memory status` warns about it. `sslmode=disable` to another host is refused unless `allow_insecure` is set.
- **First start:** Lunos creates the table `lunos_memory_fact` and its indexes, so the user needs `CREATE` on the database's schema once. After that, read and write access is enough, or read access with `read_only: true`.
- **Driver:** Bun's built-in PostgreSQL client, so no extra package is installed.
- pgvector embeddings are **not** used yet. The Docker template's image includes pgvector so that adding embeddings later doesn't need a new image.

### Memgraph: coming soon

Memgraph speaks Bolt, but it fails Lunos's external-memory contract tests. It doesn't allow schema changes inside the driver's managed transactions, and it has no Neo4j-style full-text index. `"type": "memgraph"` is still refused when memory starts, and the wizard shows it greyed out as **Coming soon**.

## Help me choose

Press **?** on the storage step to answer two questions:

1. **Just you, or your team?** Just you → **On this computer**.
2. **Do you already run one of these databases?** PostgreSQL → **Team database: PostgreSQL**. Neo4j → **Team database: Neo4j**. Neither → **Team database: PostgreSQL**; to try it first, use the template _PostgreSQL in Docker on this computer_.

## Test connection

Choosing a team database runs **Test connection** before you go on. Lunos runs the same checks as connecting (the URL, TLS, credentials by reference, and the jurisdiction against your residency policy). It then connects, writes a probe, reads it back and deletes it. The probe is written in a namespace of its own, so it never touches a stored fact. A failure names the stage (`settings`, `residency`, `connect`, `write`, `read` or `delete`) and what to do. A residency refusal can't be saved. A failed connection can be saved anyway, for a database that isn't up yet.

## See what memory uses

`/memory` opens on Overview, with a **Storage** panel at the top. It shows what memory uses (on this computer, a database in Docker, a team database, or a managed cloud database) and the template that set it up, or _Custom_ when you chose by hand. It also shows the live status: connected, unreachable (with the stage and what to do), not checked yet, or memory off.

- **On this computer:** the memory path, its size on disk, and the model that extracts facts with its region.
- **A database in Docker:** the URL, and the container's name, image and state (running, stopped or missing), read with `docker` or `podman`. A stopped container offers **Start container**, which runs `docker start` after you confirm.
- **A team database:** the host, jurisdiction, TLS and read-only setting. Credentials are never shown, only the names of the environment variables or files they come from.
- **A managed cloud database:** the provider, region, and whether your residency policy allows it.

Under the panel are **Change storage…**, **Test connection** and **Open in Settings**. Test connection runs the checks above for a database, or the memory check (remember, recall and remove a test fact) on this computer, and updates "checked". When your organisation sets the storage, the panel says **Set by your organisation**, and Change storage… isn't offered. With memory off, the panel offers **Set up memory…** instead.

`lunos memory status` prints the same Storage block.

## Switching storage later

Change the storage from `/memory` with **Change storage…**, from **/settings → Memory → Change memory setup…**, by running `lunos memory setup` again, or with `lunos memory storage set`. They show the same cards and templates. If memory is already on and the storage changes, the summary asks what happens to your facts:

- **Move my facts.** Every fact is exported from the storage in use now, through the same bundle as `lunos memory export`. It's then imported into the new storage with `lunos memory migrate --from-bundle`. Moving into a team database keeps each fact's id and provenance as they were. Moving onto this computer keeps the provenance; the facts are extracted again with your model, so they get new ids. The old copy is left where it is.
- **Start empty.** The new storage starts with no facts. The old ones stay, untouched, and the summary says where.

The move happens before the new settings are saved, and the facts are counted on both sides. If it fails, or a fact is missing, nothing is saved.

From a script:

```sh
lunos memory storage set --template neo4j-docker --start --move --yes
lunos memory storage set --backend postgres --url postgres://db.internal:5432/lunos --jurisdiction EU-DE --empty --yes
lunos memory storage set --backend embedded --move --yes
```

With `--yes`, a change of storage needs `--move` or `--empty`. Applying a template records its name as `memory.template`, which is how `/memory` knows which template set it up.

See also: [Memory templates](memory-templates.md), and [External memory database](deployment/self-hosted.md#external-memory-database) for the full security notes on team databases.
