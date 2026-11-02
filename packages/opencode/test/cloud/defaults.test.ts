import { expect, test } from "bun:test"
import { CloudDefaults } from "@/cloud/defaults"

test("defaults", () => {
  expect(CloudDefaults.DEFAULT_ISSUER).toBe("https://auth.lunos.tech/realms/Lunos")
  expect(CloudDefaults.DEFAULT_ENDPOINT).toBe("https://cloud.lunos.tech")
})
