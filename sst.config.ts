/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "opencode",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "cloudflare",
      providers: {
        aws: {
          version: "7.30.0",
          region: "us-east-1",
          profile: process.env.GITHUB_ACTIONS
            ? undefined
            : input.stage === "production"
              ? "opencode-production"
              : "opencode-dev",
        },
        stripe: {
          version: "0.0.28",
          apiKey: process.env.STRIPE_SECRET_KEY!,
        },
        random: "4.19.2",
        planetscale: "0.4.1",
        honeycomb: "0.49.0",
      },
    }
  },
  async run() {
    const stage = await import("./infra/stage.js")
    await import("./infra/app.js")
    const lake = stage.deployAws ? await import("./infra/lake.js") : undefined
    const stats = stage.deployAws ? await import("./infra/stats.js") : undefined
    const { stat } = await import("./infra/console.js")
    await import("./infra/enterprise.js")
    // XCOD-34 (F-001): the marketplace registry Worker and its EU-jurisdiction D1 database
    // are gated behind an explicit opt-in and are NOT provisioned by an ordinary deploy.
    // D1's `jurisdiction` is create-time-only and irreversible — a wrongly-jurisdictioned
    // database must be destroyed and recreated, not patched — so creating it has to be a
    // deliberate, authorized act, never a side effect of deploying something else.
    // F-001's deploy step is therefore, explicitly:
    //   LUNOS_DEPLOY_REGISTRY=1 bun sst deploy --stage=<stage>
    // An ordinary `bun sst deploy` intentionally skips this module entirely.
    if (process.env.LUNOS_DEPLOY_REGISTRY === "1") {
      await import("./infra/registry.js")
    }
    if ($app.stage === "production" || $app.stage === "vimtor") {
      await import("./infra/monitoring.js")
    }

    return {
      StatWorkerUrl: stat.url,
      ...(stats ? { StatsUrl: stats.app.url } : {}),
      ...(lake
        ? {
            LakeUrl: lake.lakeIngest.properties.url,
            LakeSecretSsm: lake.ingestSecretSsm.name,
          }
        : {}),
      AwsStage: stage.awsStage,
    }
  },
})
