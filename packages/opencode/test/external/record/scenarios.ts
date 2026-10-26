// XCOD-270: what the external-fixture recorder records from each tool, and the releases the
// contract tests expect recordings of. Prompts are trivial so a real run costs next to nothing; the
// bridge is a stand-in MCP server (fake-mcp-server.ts, one tool `say`), and a "hook" denial is the
// refusal a Lunos hook gives, so no Lunos server runs.
import type { ExternalClaude } from "../../../src/external/claude"
import type { ExternalDetect } from "../../../src/external/detect"
import { ExternalHooks } from "../../../src/external/hooks"

export const VERSIONS: Record<ExternalDetect.Tool, string> = { claude: "2.1.292", codex: "0.160.1" }

/** How a recorded approval was answered; replay answers the same way. */
export type Decide = "allow" | "hook-deny"

export type Step =
  | { kind: "models" }
  | {
      kind: "turn"
      prompt: string
      /** Which of the two switch models to ask for (picked from the tool's model list, or `--models`). */
      model?: "first" | "second"
      /** Resume the previous step's session. */
      resume?: boolean
      /** Give the tool the stand-in Lunos bridge. */
      bridge?: boolean
      decide: Decide
    }

export interface Scenario {
  name: string
  steps: Step[]
  /** Only when recording the fake tools: the FAKE_* switches that make them act out the scenario. */
  fake?: Partial<Record<ExternalDetect.Tool, Record<string, string>>>
}

const OK = "Say ok and nothing else."

export const SCENARIOS: Scenario[] = [
  { name: "start-models", steps: [{ kind: "models" }] },
  {
    name: "resume-model-switch",
    steps: [
      { kind: "turn", prompt: OK, model: "first", decide: "allow" },
      { kind: "turn", prompt: OK, model: "second", resume: true, decide: "allow" },
    ],
  },
  {
    name: "bridge-call",
    steps: [
      {
        kind: "turn",
        prompt: 'Call the say tool of the lunos MCP server once with the text "ok", then say ok.',
        bridge: true,
        decide: "allow",
      },
    ],
    fake: {
      claude: { FAKE_CLAUDE_BRIDGE_CALL: "say", FAKE_CLAUDE_BRIDGE_ARGS: '{"text":"ok"}' },
      codex: {
        FAKE_CODEX_BRIDGE_CALL: "say",
        FAKE_CODEX_BRIDGE_ARGS: '{"text":"ok"}',
        FAKE_CODEX_BRIDGE_APPROVAL: "1",
      },
    },
  },
  {
    name: "native-approval",
    steps: [
      { kind: "turn", prompt: "Create a file named ok.txt containing the word ok. Nothing else.", decide: "allow" },
    ],
  },
  {
    name: "hook-denied",
    steps: [{ kind: "turn", prompt: "Run the shell command `touch denied.txt`. Nothing else.", decide: "hook-deny" }],
    fake: { claude: { FAKE_CLAUDE_BASH: "touch denied.txt" }, codex: { FAKE_CODEX_BASH: "touch denied.txt" } },
  },
  {
    name: "compact",
    steps: [
      { kind: "turn", prompt: OK, decide: "allow" },
      { kind: "turn", prompt: "/compact", resume: true, decide: "allow" },
    ],
  },
]

export const HOOK_MESSAGE = "blocked by the fixture hook"

export function decision(decide: Decide): ExternalClaude.PermissionDecision {
  return decide === "allow"
    ? { allow: true }
    : { allow: false, message: ExternalHooks.refusal(new Error(HOOK_MESSAGE)) }
}
