# Memory templates

A memory template is a ready-made setup. It sets where memory is stored, how it searches and which model it uses, in one go, and some templates also write the files to run a database. The storage step of memory setup starts with **Start from a template**; **Choose storage myself** is the other path (see [Where memory is stored](memory-storage.md)).

```sh
lunos memory templates                                       # list them
lunos memory setup --template neo4j-docker                   # preview, write, then ask before starting it
lunos memory setup --template postgres-docker --yes          # writes the files; never starts the database
lunos memory setup --template postgres-docker --yes --start  # writes the files and starts the database
lunos memory setup --template team-hosted --yes --vendor postgres --url postgres://db.internal:5432/lunos --jurisdiction EU-DE
```

`--yes` with no template still picks **On this computer**.

## The built-in templates

| Template                                  | Name              | What it sets up                                                                                                                                                                 | Leaves the computer                                               |
| ----------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Just me, on this computer** (default)   | `just-me`         | memory on this computer, with the fact ledger encrypted by a key in your OS keychain                                                                                            | the fact text, to your model, to pull out names and relationships |
| **Just me, fully local**                  | `fully-local`     | memory on this computer, with facts extracted by a model that runs on this computer. Offered only when a configured provider's endpoint is on this computer (Ollama, LM Studio) | nothing                                                           |
| **Neo4j in Docker on this computer**      | `neo4j-docker`    | a compose file for the official `neo4j:5` Community image, plus the memory backend `neo4j` at `bolt://localhost:7687`                                                           | nothing: no model calls, and the database runs on this computer   |
| **PostgreSQL in Docker on this computer** | `postgres-docker` | a compose file for `pgvector/pgvector:pg17`, plus the memory backend `postgres` at `postgres://localhost:5432/lunos_memory`                                                     | nothing: no model calls, and the database runs on this computer   |
| **Team database we host**                 | `team-hosted`     | Neo4j or PostgreSQL on your server: TLS required, credentials from environment variables, and the region you enter                                                              | the fact text, to your database                                   |
| **Managed cloud database**                | `managed-cloud`   | Neo4j Aura or a managed PostgreSQL: you pick the region, and your residency policy is checked at this step                                                                      | the fact text, to the provider, in the region you pick            |

Lunos makes no claim about a managed provider's jurisdiction. You enter the region your contract says, and the residency policy is checked against that.

## How the Docker templates work

1. **Docker or Podman, with compose.** Lunos looks for `docker`, then `podman`, and checks `compose version`. Without them, the Docker templates are still listed, marked "Docker or Podman not found" (or "Docker Compose not found") with the install link, and can't be applied.
2. **Preview before writing.** The compose file, the `.env` file (the password masked), `.env.example`, the memory config block and the image's licence are shown in full first. The files go to `<Lunos config directory>/memory/<template>/` (for example `~/.config/opencode/memory/neo4j-docker/`) for the user config. For the project config, they go to `.opencode/memory/<template>/` in the project, with a `.gitignore` that keeps `.env` out of git. An existing file is never replaced without asking. With `--yes`, an existing file stops the setup, and nothing is written.
3. **Passwords.** A random 32-character password is generated. It's written only to `.env`, with permissions `0600`. The config gets `{env:NEO4J_USER}` / `{env:NEO4J_PASSWORD}` (or the `POSTGRES_` ones) references, never the password. Lunos reads those variables from its environment, so load the file before starting Lunos: `set -a; . <dir>/.env; set +a`. The setup check loads it for you.
4. **Start it now** runs `docker compose … up -d`, and only after you confirm the exact command, which is shown. It then waits up to 2 minutes for the healthcheck, showing progress, and runs the memory check. **I'll start it myself** shows the command to copy. With `--yes`, the database is started only with `--start`.
5. **Bound to `127.0.0.1` only.** The database can't be reached from the network. Exposing it is a manual change to the compose file; put TLS in front of it first (see [External memory database](deployment/self-hosted.md#external-memory-database)).
6. **Licences are the image vendors'.** Lunos doesn't ship or pin the images beyond the tag in the generated file. Neo4j Community Edition is licensed under the GPLv3 by Neo4j, Inc. PostgreSQL and pgvector are released under the PostgreSQL Licence.

A database on this computer is declared with `"jurisdiction": "local"`. That's accepted only when the URL's host is this computer (`localhost`, `127.x`, `::1`), and a residency policy doesn't refuse it, since the data doesn't leave the computer.

### neo4j-docker

<!-- template:neo4j-docker:start -->

`docker-compose.yml`:

```yaml
# Generated by Lunos (memory template neo4j-docker).
# Neo4j Community Edition is licensed under the GPLv3 by Neo4j, Inc.
# Bound to 127.0.0.1 only: reachable from this computer, not from the network.
name: lunos-memory-neo4j-docker
services:
  neo4j:
    image: neo4j:5
    restart: unless-stopped
    environment:
      NEO4J_AUTH: ${NEO4J_USER}/${NEO4J_PASSWORD}
      # Not NEO4J_*: the image reads those as Neo4j settings.
      LUNOS_HEALTHCHECK_PASSWORD: ${NEO4J_PASSWORD}
    ports:
      - "127.0.0.1:${NEO4J_BOLT_PORT:-7687}:7687"
    volumes:
      - data:/data
    healthcheck:
      test: ["CMD-SHELL", 'cypher-shell -u neo4j -p "$$LUNOS_HEALTHCHECK_PASSWORD" ''RETURN 1'' >/dev/null 2>&1']
      interval: 5s
      timeout: 10s
      retries: 24
      start_period: 10s
volumes:
  data:
```

`.env.example` (the `.env` has the generated password):

```sh
NEO4J_USER=neo4j
NEO4J_PASSWORD=
NEO4J_BOLT_PORT=7687
```

<!-- template:neo4j-docker:end -->

### postgres-docker

<!-- template:postgres-docker:start -->

`docker-compose.yml`:

```yaml
# Generated by Lunos (memory template postgres-docker).
# PostgreSQL and pgvector are released under the PostgreSQL Licence.
# Bound to 127.0.0.1 only: reachable from this computer, not from the network.
name: lunos-memory-postgres-docker
services:
  postgres:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: lunos_memory
    ports:
      - "127.0.0.1:${POSTGRES_PORT:-5432}:5432"
    volumes:
      - data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", 'pg_isready -U "$$POSTGRES_USER" -d lunos_memory']
      interval: 3s
      timeout: 5s
      retries: 40
volumes:
  data:
```

`.env.example` (the `.env` has the generated password):

```sh
POSTGRES_USER=lunos
POSTGRES_PASSWORD=
POSTGRES_PORT=5432
```

<!-- template:postgres-docker:end -->

## Your organisation's templates

An organisation can ship its own templates, and hide built-in ones, in managed config:

```jsonc
"memory": {
  "templates": {
    "custom": [
      {
        "name": "acme-neo4j",
        "title": "Our team Neo4j",
        "leaves": "the fact text, to Acme's Neo4j in Frankfurt",
        "memory": {
          "backend": {
            "type": "neo4j",
            "url": "bolt+s://graph.acme.internal:7687",
            "username": "{env:NEO4J_USER}",
            "password": "{env:NEO4J_PASSWORD}",
            "jurisdiction": "EU-DE"
          },
          "encryption": "off"
        }
      }
    ],
    "hide": ["neo4j-docker", "postgres-docker", "managed-cloud"]
  }
}
```

The organisation's templates are listed first. Keys the organisation locks (`$locked`) stay as they are whichever template is picked: the wizard never writes a locked key.

The built-in templates are data, not code: `packages/core/src/memory-templates/*.json`.
