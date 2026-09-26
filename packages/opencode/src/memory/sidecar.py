# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["cognee==1.6.1", "mcp==1.30.0", "fastembed==0.8.0"]
# ///
"""Lunos memory sidecar (XCOD-94).

A stdio MCP server that Lunos starts on demand and talks to over its own private MCP client. Its
tools are never offered to the model: Lunos's memory_remember / memory_search tools call them
after their own checks. Cognee runs with:

- its LLM routed back to Lunos through MCP sampling, so extraction uses the model the user chose,
  under Lunos's residency policy, with no API key handed to this process;
- local embeddings (fastembed), so nothing is sent anywhere to embed;
- every data directory under the path Lunos passes as LUNOS_MEMORY_DIR;
- telemetry off, GLiNER's auto-install off, and litellm's remote cost map off.

Lunos sets the environment below before starting this script too; the defaults here are a second
line, so running the script by hand can't phone home either.
"""

import os
import re
import sys

ROOT = os.environ["LUNOS_MEMORY_DIR"]
MODELS = os.environ.get("LUNOS_MEMORY_MODELS", os.path.join(ROOT, "models"))
for key, value in {
    "TELEMETRY_DISABLED": "1",
    "LLM_PROVIDER": "mcp-sampling",
    "LLM_MODEL": "lunos",
    "LLM_API_KEY": "unused",
    "STRUCTURED_OUTPUT_FRAMEWORK": "instructor",
    "GRAPH_EXTRACTOR": "llm",
    "GLINER_AUTO_INSTALL": "false",
    "COGNEE_SKIP_CONNECTION_TEST": "true",
    "LITELLM_LOCAL_MODEL_COST_MAP": "True",
    "EMBEDDING_PROVIDER": "fastembed",
    "EMBEDDING_MODEL": "sentence-transformers/all-MiniLM-L6-v2",
    "EMBEDDING_DIMENSIONS": "384",
    "DATA_ROOT_DIRECTORY": os.path.join(ROOT, "data"),
    "SYSTEM_ROOT_DIRECTORY": os.path.join(ROOT, "system"),
    "CACHE_ROOT_DIRECTORY": os.path.join(ROOT, "cache"),
    "COGNEE_LOGS_DIR": os.path.join(ROOT, "logs"),
    "FASTEMBED_CACHE_PATH": os.path.join(MODELS, "fastembed"),
    "HF_HOME": os.path.join(MODELS, "huggingface"),
    "ENV": "local",
}.items():
    os.environ.setdefault(key, value)

# stdout is the MCP channel. Anything cognee prints goes to stderr instead.
_stdout = sys.stdout
sys.stdout = sys.stderr

from mcp.server.fastmcp import FastMCP  # noqa: E402

import cognee  # noqa: E402
from cognee import SearchType  # noqa: E402

sys.stdout = _stdout
server = FastMCP("lunos-memory")


def _quiet():
    class Quiet:
        def __enter__(self):
            self.saved = sys.stdout
            sys.stdout = sys.stderr

        def __exit__(self, *exc):
            sys.stdout = self.saved

    return Quiet()


_ready = False


async def _data_ids(dataset: str) -> set:
    from cognee.modules.data.methods import get_dataset_data, get_datasets_by_name
    from cognee.modules.engine.operations.setup import setup
    from cognee.modules.users.methods import get_default_user

    global _ready
    if not _ready:
        await setup()  # creates the databases on a fresh store; a no-op afterwards
        _ready = True
    user = await get_default_user()
    found = await get_datasets_by_name([dataset], user.id)
    if not found:
        return set()
    return {str(item.id) for item in await get_dataset_data(found[0].id)}


@server.tool()
async def remember(text: str, dataset: str) -> dict:
    """Store one fact. Extraction runs inside this request so it can use MCP sampling."""
    with _quiet():
        before = await _data_ids(dataset)
        result = await cognee.remember(text, dataset_name=dataset, self_improvement=False)
        added = (await _data_ids(dataset)) - before
    # cognify reruns over the whole dataset, so result.items can list earlier facts too. The new
    # fact is the one data item that wasn't there before.
    if len(added) != 1:
        raise RuntimeError(f"expected one new data item, found {len(added)} (is this fact already stored?)")
    return {"id": added.pop(), "dataset_id": str(result.dataset_id)}


@server.tool()
async def recall(query: str, dataset: str, top_k: int = 10) -> dict:
    """Facts closest to the query, and the graph relationships around them. No LLM call."""
    with _quiet():
        chunks = await cognee.recall(
            query, query_type=SearchType.CHUNKS, datasets=[dataset], auto_route=False, top_k=top_k
        )
        graph = await cognee.recall(
            query,
            query_type=SearchType.GRAPH_COMPLETION,
            datasets=[dataset],
            auto_route=False,
            only_context=True,
            top_k=top_k,
        )
    facts = [
        {"id": c.metadata.get("data_id"), "text": c.text, "score": c.score}
        for c in chunks
        if getattr(c, "metadata", None) and c.metadata.get("data_id")
    ]
    return {"facts": facts, "graph": "\n".join(_relations("\n".join(str(g.text) for g in graph)))}


_EDGE = re.compile(r"^(?P<a>.+?) --\[(?P<rel>[^\]]+)\]--> (?P<b>.+?)(?:  \(.*\))?`?$")


def _relations(context: str) -> list:
    """Entity-to-entity relationships from cognee's graph context, and nothing else.

    The context cognee builds for its own completion prompt wraps the graph in instructions
    ("The question is: ...") and includes chunk nodes and document ids. Only lines like
    ``billing service --[owns]--> invoices table`` between named entities are kept.
    """
    out = []
    for line in context.split("Connections:", 1)[-1].splitlines():
        match = _EDGE.match(line.strip())
        if not match:
            continue
        a, b = match["a"].strip(), match["b"].strip()
        if any("..." in side or side.startswith("text_") or "[" in side for side in (a, b)):
            continue
        edge = f"{a} --[{match['rel']}]--> {b}"
        if edge not in out:
            out.append(edge)
    return out


@server.tool()
async def forget(id: str, dataset_id: str) -> dict:
    """Remove one fact, and the graph nodes and edges derived only from it."""
    from uuid import UUID

    with _quiet():
        result = await cognee.forget(data_id=UUID(id), dataset_id=UUID(dataset_id))
    return {"status": result.get("status", "unknown")}


if __name__ == "__main__":
    server.run("stdio")
