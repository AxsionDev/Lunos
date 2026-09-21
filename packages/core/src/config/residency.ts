export * as ConfigResidency from "./residency"

import { Schema } from "effect"

/**
 * Data-residency policy (XCOD-62). Absent from config = feature entirely off, no enforcement
 * and no logging, so deployments that don't need this pay nothing for it.
 */
export class Info extends Schema.Class<Info>("ConfigV2.Residency")({
  allow: Schema.Literals(["eu", "us", "other", "configurable", "unknown"]).pipe(Schema.Array).annotate({
    description:
      'Regions this deployment may send model requests to, e.g. ["eu"]. Providers outside this list are blocked before any request is made. Providers with no recorded jurisdiction are always denied. "configurable" providers (Azure, Bedrock, Vertex) are denied unless explicitly listed, because their region cannot be verified from here.',
  }),
  audit: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Write an audit log of outbound model calls. Defaults to true whenever a residency policy is set; set false to opt out.",
  }),
  auditPath: Schema.String.pipe(Schema.optional).annotate({
    description: "Path of the audit log. Defaults to residency-egress.log in the Lunos data directory.",
  }),
}) {}
