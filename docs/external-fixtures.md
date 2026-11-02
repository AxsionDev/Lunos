# Recording Claude Code and Codex fixtures

Lunos drives Claude Code and Codex CLI through their own protocols (stream-json and the Codex app server). The adapters are tested against fake tools, and the fakes were written from what the protocols are known to send. To check them against a real release, a maintainer records the real tools once with `packages/opencode/script/record-external-fixtures.ts`. The contract tests in `packages/opencode/test/external/contract/` then replay those recordings against the adapters, with no tool and no network involved.

Until the recordings for the pinned releases (Claude Code 2.1.292, Codex 0.160.1) are committed, the contract tests are skipped, and their names say so.

## What a recording sends

**A real recording sends a few trivial prompts to Anthropic and OpenAI**, and they are billed to the key you give. Each tool gets about eight prompts in all: one per step of these scenarios.

| Scenario              | What the tool is asked                                                              |
| --------------------- | ----------------------------------------------------------------------------------- |
| `start-models`        | Nothing: the tool is started, lists its models, and is stopped. No model is called. |
| `resume-model-switch` | "Say ok" with one model, then again on the resumed session with another model.      |
| `bridge-call`         | Call the `say` tool of a stand-in MCP server named `lunos` (allowed).               |
| `native-approval`     | Create `ok.txt` containing "ok" (allowed).                                          |
| `hook-denied`         | Run `touch denied.txt` (refused the way a Lunos hook refuses it).                   |
| `compact`             | "Say ok", then `/compact` on the resumed session.                                   |

The bridge is a stand-in (`test/external/fixtures/fake-mcp-server.ts`), and the hook refusal is the message a Lunos hook gives. So no Lunos server, memory or plugin is involved.

## Which key to use

Use a **dedicated test key**, never your own login:

- Claude Code: an Anthropic API key from a test workspace with a low spend limit.
- Codex: an OpenAI API key from a test project with a low spend limit.

Put each key in an environment variable and pass the variable's _name_. The recorder never takes a key on its command line:

```sh
export LUNOS_TEST_ANTHROPIC_KEY=…   # test workspace key
export LUNOS_TEST_OPENAI_KEY=…      # test project key
cd packages/opencode
LUNOS_RECORD_EXTERNAL=1 bun script/record-external-fixtures.ts \
  --claude-key-env LUNOS_TEST_ANTHROPIC_KEY --codex-key-env LUNOS_TEST_OPENAI_KEY --dry-run
```

`--dry-run` prints the environment, the exact commands and what is sent on stdin, and runs nothing. Not even `--version` is run. Drop `--dry-run` to record. Without `LUNOS_RECORD_EXTERNAL=1`, or without a `--<tool>-key-env` for each tool recorded, the recorder refuses to start.

Other options:

- `--tool claude` records one tool.
- `--scenario compact` records one scenario.
- `--binary claude=/path/to/claude` picks a binary other than the one on `PATH`.
- `--models codex=<a>,<b>` picks the two models of the switch. The default is the first two the tool lists.
- `--keep` keeps the throwaway directory for inspection.

## How the user's login is kept out

- Each tool runs in a throwaway HOME, XDG directories, TMPDIR and project. Its environment is built from scratch: only `PATH` and the locale are kept from yours.
- Claude Code gets the key as `ANTHROPIC_API_KEY`. Before any prompt, the recorder asks Claude Code (initialize only) which account it uses, and stops if that is a personal login. After each turn it stops unless the `init` line says a key was used (`apiKeySource`).
- Codex gets the key through `codex login --with-api-key` on stdin, so it lands in the throwaway `~/.codex`. The recorder stops unless `codex login status` then reports an API key login.
- Every line is redacted before it is written. That removes:
  - the key itself;
  - anything shaped like a key, token, JWT or e-mail;
  - values under secret-looking keys (`*token`, `*api_key`, `accountId`, `email`, …);
  - the machine's paths (the throwaway HOME becomes `<home>`, the project `<project>`).
- Session and thread ids are kept, because a replayed resume needs them.
- If the redacted result still contains anything that looks identifying, nothing is written.

**Check these on the first real run.** They are not verified yet:

- the `apiKeySource` value Claude Code 2.1.292 reports for an environment key;
- that `codex login --with-api-key` exists in 0.160.1;
- whether macOS lets Claude Code read a login stored in the Keychain even with HOME swapped.

For full isolation, record in a Linux container or under a separate macOS user that has never logged in to either tool.

## What gets written

The recordings go to `packages/opencode/test/fixtures/external/<tool>-<version>/`:

- one `<scenario>.<n>.jsonl` per process the step started, where each line is `{ from: "argv" | "host" | "tool" | "stderr" | "exit", … }`;
- a `manifest.json` with the options each step used.

For each step, the manifest also lists the files the tool added, changed or removed under the throwaway HOME. These are paths only, not their contents, and they answer what a start does to `~/.claude` and `~/.codex`.

Then run the contract tests and review the diff before committing:

```sh
cd packages/opencode
bun test test/external/contract test/external/record
```

The `fake-claude-*` and `fake-codex-*` folders hold recordings of the test fakes, made with the same recorder (`--fake --binary claude=test/external/fixtures/fake-claude.ts`). They prove the recorder and the replay harness; they say nothing about the real tools.

When a contract test fails against a real recording, it has found something the fakes got wrong. Fix the adapter (and the fake), not the recording, and note the result in the "Verified against" table in [external-agents.md](external-agents.md#verified-against).
