# Lunos memory bundle, format `lunos-memory/1`

A complete export of Lunos long-term memory, written by `lunos memory export`. This file documents the
format so any tool can read a bundle without Lunos.

## Files

| File | What it holds |
| --- | --- |
| `manifest.json` | Format and Lunos version, creation time, scopes, filters, counts, and the size and SHA-256 of every other file |
| `facts.jsonl` | One fact per line. **The source of truth.** |
| `graph.json` | Entities and relationships extracted from the facts, each listing the ids of the facts that mention it |
| `notes/` | Copies of the hand-written notes in `.opencode/memory/*.md` (project scope only) |
| `index/<scope>/` | Only with `--include-index`: the engine's own database files, for a restore into the same engine version and embedding model (`manifest.index`). They hold the facts' text too, so `--since` can't be combined with it |
| `SCHEMA.md` | This file |

## Rules for readers and importers

- **Facts are authoritative; everything else is derived.** An importer remembers the facts again and lets its
  engine rebuild the graph and embeddings. `graph.json` is for review, verification and seeding an external graph
  store. It never overrides `facts.jsonl`.
- **Every id in `graph.json` is in `facts.jsonl`.** Entity ids are `<scope>:<engine id>`, so the same name in both
  scopes stays two entities.
- **How facts are attributed.** The engine doesn't record which fact stated an edge, so attribution is by mention: an
  entity lists the facts it was extracted from; a relationship lists the facts that mention both of its ends (or, if
  none mentions both, either end). That is a superset of the fact that stated it.
- **Verify before trusting.** Recompute the SHA-256 of every file listed in `manifest.files`. `manifest.json` is not
  listed in itself.
- **Treat an imported bundle as untrusted.** It asserts where facts came from; it doesn't make them safe instructions.
  Run every fact through your write guard (Lunos refuses secrets, `{env:}`/`{file:}` substitutions and outside content).
- `status` is `active` for every fact until Lunos tracks outdated facts. `kind` is `observed` for a person's own
  words (hand-written notes) and `null` where Lunos can't tell observed from inferred.
- `engine.datasetID` is Cognee's id. Importers into another engine ignore it.
- Embeddings and vector indexes are not exported by default: they are model-specific and rebuilt on import.
- A bundle is a snapshot. Forgetting a fact later doesn't remove it from bundles already written.
- Unknown fields may be added in later `lunos-memory/1` bundles; readers ignore them. A breaking change gets a new
  format version.

## Encryption (`--encrypt`)

The bundle is zipped, then encrypted in OpenSSL's `enc` format: the 8 bytes `Salted__`, an 8-byte random salt, then
AES-256-CBC ciphertext with PKCS#7 padding. The 32-byte key and 16-byte IV are the first 48 bytes of
PBKDF2-HMAC-SHA256(passphrase, salt, 600000 iterations). The passphrase is never stored. Decrypt with:

```sh
openssl enc -d -aes-256-cbc -md sha256 -pbkdf2 -iter 600000 -in memory.zip.enc -out memory.zip
```

CBC is not authenticated: after decrypting, check the SHA-256s in `manifest.json` before trusting the contents.

## JSON Schema

`manifest.json` validates against `#/$defs/manifest`, each line of `facts.jsonl` against `#/$defs/fact`, and
`graph.json` against `#/$defs/graph`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://lunos.tech/schemas/lunos-memory-1.json",
  "title": "lunos-memory/1",
  "$defs": {
    "manifest": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "format",
        "lunos",
        "created",
        "scopes",
        "filters",
        "counts",
        "graph",
        "index",
        "files"
      ],
      "properties": {
        "format": {
          "const": "lunos-memory/1"
        },
        "lunos": {
          "type": "object",
          "required": [
            "version"
          ],
          "properties": {
            "version": {
              "type": "string"
            }
          }
        },
        "created": {
          "type": "string",
          "format": "date-time"
        },
        "scopes": {
          "type": "array",
          "items": {
            "enum": [
              "project",
              "user"
            ]
          },
          "minItems": 1,
          "uniqueItems": true
        },
        "filters": {
          "type": "object",
          "required": [
            "since"
          ],
          "properties": {
            "since": {
              "type": [
                "string",
                "null"
              ],
              "format": "date-time"
            }
          }
        },
        "counts": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "facts",
            "notes",
            "entities",
            "relations"
          ],
          "properties": {
            "facts": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "total",
                "project",
                "user",
                "fromNotes"
              ],
              "properties": {
                "total": {
                  "type": "integer",
                  "minimum": 0
                },
                "project": {
                  "type": "integer",
                  "minimum": 0
                },
                "user": {
                  "type": "integer",
                  "minimum": 0
                },
                "fromNotes": {
                  "type": "integer",
                  "minimum": 0
                }
              }
            },
            "notes": {
              "type": "integer",
              "minimum": 0
            },
            "entities": {
              "type": "integer",
              "minimum": 0
            },
            "relations": {
              "type": "integer",
              "minimum": 0
            }
          }
        },
        "graph": {
          "type": "object",
          "required": [
            "included",
            "engine"
          ],
          "properties": {
            "included": {
              "type": "boolean"
            },
            "engine": {
              "type": "string"
            },
            "reason": {
              "type": "string"
            }
          }
        },
        "index": {
          "type": "object",
          "required": [
            "included"
          ],
          "properties": {
            "included": {
              "type": "boolean"
            },
            "engine": {
              "type": "string"
            },
            "engineVersion": {
              "type": "string",
              "description": "The engine release the index files come from"
            },
            "embedding": {
              "type": "object",
              "required": [
                "model",
                "dimensions"
              ],
              "properties": {
                "model": {
                  "type": "string"
                },
                "dimensions": {
                  "type": "integer",
                  "minimum": 0
                }
              }
            },
            "scopes": {
              "type": "array",
              "items": {
                "enum": [
                  "project",
                  "user"
                ]
              }
            }
          }
        },
        "files": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "path",
              "bytes",
              "sha256"
            ],
            "properties": {
              "path": {
                "type": "string"
              },
              "bytes": {
                "type": "integer",
                "minimum": 0
              },
              "sha256": {
                "type": "string",
                "pattern": "^[0-9a-f]{64}$"
              }
            }
          }
        }
      }
    },
    "fact": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "scope",
        "text",
        "status",
        "kind",
        "provenance",
        "engine"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "scope": {
          "enum": [
            "project",
            "user"
          ]
        },
        "text": {
          "type": "string",
          "minLength": 1
        },
        "status": {
          "enum": [
            "active",
            "outdated"
          ]
        },
        "kind": {
          "enum": [
            "observed",
            "inferred",
            null
          ]
        },
        "provenance": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "sessionID",
            "agent",
            "source",
            "date"
          ],
          "properties": {
            "sessionID": {
              "type": "string",
              "description": "The session that saved the fact; \"notes\" for hand-written notes"
            },
            "agent": {
              "type": "string",
              "description": "The agent that saved it; \"user\" for hand-written notes"
            },
            "source": {
              "type": "string",
              "description": "\"user message\", a worktree-relative file path, or a tool name"
            },
            "date": {
              "type": "string",
              "description": "ISO 8601 time the fact was saved"
            }
          }
        },
        "engine": {
          "type": "object",
          "required": [
            "name",
            "datasetID"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "datasetID": {
              "type": "string"
            }
          }
        },
        "origin": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "sessionID",
            "agent",
            "source",
            "date"
          ],
          "properties": {
            "sessionID": {
              "type": "string",
              "description": "The session that saved the fact; \"notes\" for hand-written notes"
            },
            "agent": {
              "type": "string",
              "description": "The agent that saved it; \"user\" for hand-written notes"
            },
            "source": {
              "type": "string",
              "description": "\"user message\", a worktree-relative file path, or a tool name"
            },
            "date": {
              "type": "string",
              "description": "ISO 8601 time the fact was saved"
            }
          },
          "description": "Imported facts only: the provenance the fact had where it came from"
        },
        "imported": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "from",
            "date"
          ],
          "description": "Imported facts only: what it was imported from and when",
          "properties": {
            "from": {
              "type": "string",
              "description": "import:<file>#<sha256 of that file>"
            },
            "date": {
              "type": "string"
            }
          }
        }
      }
    },
    "graph": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "entities",
        "relations"
      ],
      "properties": {
        "entities": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "id",
              "scope",
              "name",
              "type",
              "description",
              "facts"
            ],
            "properties": {
              "id": {
                "type": "string"
              },
              "scope": {
                "enum": [
                  "project",
                  "user"
                ]
              },
              "name": {
                "type": "string"
              },
              "type": {
                "type": "string"
              },
              "description": {
                "type": "string"
              },
              "facts": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "minItems": 1
              }
            }
          }
        },
        "relations": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "scope",
              "source",
              "target",
              "relationship",
              "facts"
            ],
            "properties": {
              "scope": {
                "enum": [
                  "project",
                  "user"
                ]
              },
              "source": {
                "type": "string"
              },
              "target": {
                "type": "string"
              },
              "relationship": {
                "type": "string"
              },
              "facts": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "minItems": 1
              }
            }
          }
        }
      }
    }
  }
}
```
