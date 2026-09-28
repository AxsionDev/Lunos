// XCOD-119: a Harbor job config for one model and one trial. Harbor runs each task in its own
// container with the Lunos agent (harbor/lunos_agent.py); the model's provider points at the
// metering proxy, which holds the key.

import type { EvalConfig, ModelConfig } from "./config"

export function lunosConfig(model: ModelConfig, proxyURL: string, auditPath: string) {
  const [provider, id] = model.model.split("/", 2)
  return {
    $schema: "https://opencode.ai/config.json",
    model: model.model,
    small_model: model.model,
    enabled_providers: [provider],
    provider: {
      [provider]: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${proxyURL}/${model.id}/v1`, apiKey: "via-lunos-eval-proxy" },
        models: { [id]: { name: id, tool_call: true } },
      },
    },
    residency: {
      allow: model.residency,
      audit: true,
      auditPath,
      // The provider points at the metering proxy, not its own API, so its built-in claim doesn't
      // apply (XCOD-138). Declare it: the proxy forwards to model.upstream, whose region the eval
      // config states. The proxy's upstream log is the evidence of where traffic went.
      endpoints: {
        [provider]: {
          region: model.residency.find((region) => region === "eu" || region === "us" || region === "other") ?? "other",
          note: `Lunos eval metering proxy, forwarding to ${new URL(model.upstream).host}`,
        },
      },
    },
    share: "disabled",
    autoupdate: false,
  }
}

export function harborJob(input: {
  config: EvalConfig
  model: ModelConfig
  trial: number
  proxyURL: string
  jobsDir: string
  concurrency: number
  /** A built-in Harbor agent instead of Lunos, e.g. "oracle" to check the pipeline for free. */
  agent?: string
}) {
  const { config, model } = input
  return {
    job_name: `${model.id}-t${input.trial}`,
    jobs_dir: input.jobsDir,
    n_attempts: 1,
    n_concurrent_trials: input.concurrency,
    quiet: true,
    // A retried trial spends twice; a failure is a result.
    retry: { max_retries: 0 },
    environment: { type: "docker", delete: true },
    agents: [
      input.agent
        ? { name: input.agent, model_name: model.model }
        : {
            import_path: "lunos_agent:Lunos",
            model_name: model.model,
            kwargs: {
              version: config.lunosVersion,
              opencode_config: lunosConfig(model, input.proxyURL, "/logs/agent/lunos-audit.log"),
            },
          },
    ],
    datasets: config.datasets.map((dataset) =>
      dataset.harbor.startsWith(".") || dataset.harbor.startsWith("/")
        ? { path: dataset.harbor, task_names: dataset.tasks }
        : { name: dataset.harbor, task_names: dataset.tasks },
    ),
  }
}
