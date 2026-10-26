# Agents

Agents are optional. Lunos works without changes here. Change an agent to give it a different model, a step limit, or other permissions.

Open the list with `/agents`, or with `/settings` → **Models & agents** → **agent**. It shows every agent, built in or your own, with what it does, its model and whether it's on. Choose one to change it. Changes go to the config scope shown in the title. In `/settings`, `ctrl+s` switches between user and project config before you open the list.

## Kinds of agent

| Kind      | Built in                                           | What they are                                                                                                           |
| --------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Main      | `build`, `plan`, `research`, `dev-cycle`           | The modes you switch between with `tab`.                                                                                |
| Subagents | `general`, `explore`, `architect`, `planner`, `qa` | Started by a main agent for a part of the work, or by you with `@name`.                                                 |
| Helpers   | `title`, `summary`, `compaction`                   | Hidden. They name sessions, summarise them, and compact long conversations. Only their model and on/off can be changed. |

## What you can change

| Setting                | Key                                               | Notes                                                                                                                          |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Model                  | `agent.<name>.model`                              | The model picker. **Inherit** (the default) uses the session's model. A subagent can also use **Small model** (`small_model`). |
| On / off               | `agent.<name>.disable`                            | An agent that's off isn't offered anywhere.                                                                                    |
| Type                   | `agent.<name>.mode`                               | `primary`, `subagent` or `all`.                                                                                                |
| Hidden from the @ menu | `agent.<name>.hidden`                             | For subagents.                                                                                                                 |
| Max steps              | `agent.<name>.steps`                              | How many tool-use rounds before the agent has to answer.                                                                       |
| Temperature, Top P     | `agent.<name>.temperature`, `agent.<name>.top_p`  | 0 to 2 and 0 to 1. Leave empty for the model's default.                                                                        |
| Description, Prompt    | `agent.<name>.description`, `agent.<name>.prompt` | The prompt opens in `$EDITOR` when it's set.                                                                                   |
| Permissions            | `agent.<name>.permission`                         | Edited in the config file, like the Permissions section of `/settings`.                                                        |
| Colour                 | `agent.<name>.color`                              | A theme colour.                                                                                                                |
| Advanced               | `agent.<name>.options`                            | Extra provider options, as JSON, in the config file.                                                                           |

**Reset to default** removes every override for that agent from the current scope. **New agent…** creates an agent of your own from a name and a description. Agents defined in a markdown file also have **Edit the agent file…**.

The same keys work from the command line:

```sh
lunos settings set agent.build.steps 25
lunos settings set agent.explore.model small --project
lunos settings unset agent.build.steps
```

Your organisation's policy (`$locked`) can lock any of these keys, or a whole agent with `agent.<name>`. Locked settings show 🔒 and can't be changed.

## Deprecated keys

Three older forms still load, but only until you migrate them:

- top-level `mode` (now `agent`)
- `tools` (now `permission`)
- `maxSteps` (now `steps`)

When any of them is set, the list shows **Migrate deprecated keys…**. Migrating rewrites them in your user and project config files. No value is lost. Where both the old and the new key are set, the new one wins, as it already does when the config loads.
