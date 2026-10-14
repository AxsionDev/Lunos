import { beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { CloudSyncQueue as Q } from "@/cloud/sync-queue"

beforeEach(async () => {
  ;(Global.Path as any).data = await fs.mkdtemp(path.join(os.tmpdir(), "q-"))
})

test("queue order, ack, drop", async () => {
  for (const seq of [1, 2, 3]) await Q.enqueue("ses_1", "/w", seq, `{"seq":${seq}}`, [`m${seq}`])
  await Q.enqueue("ses_2", "/w", 1, "{}", ["x"])
  expect((await Q.pending()).map((p) => `${p.session}:${p.seq}`)).toEqual(["ses_1:1", "ses_1:2", "ses_1:3", "ses_2:1"])
  await Q.ack("ses_1", 2)
  expect((await Q.pending("ses_1")).map((p) => p.seq)).toEqual([3])
  expect((await Q.cursor("ses_1"))!.sent).toEqual(["m1", "m2", "m3"])
  expect((await Q.cursor("ses_1"))!.seq).toBe(3)
  await Q.drop("ses_2", "deleted")
  expect(await Q.pending("ses_2")).toEqual([])
  expect((await Q.cursor("ses_2"))!.stopped).toBe("deleted")
})

test("sequence order is numeric, not lexical", async () => {
  for (const seq of [2, 10, 1]) await Q.enqueue("ses_1", "/w", seq, "{}", [])
  expect((await Q.pending("ses_1")).map((p) => p.seq)).toEqual([1, 2, 10])
})

test("the same seq twice keeps one file with the latest body", async () => {
  await Q.enqueue("ses_1", "/w", 1, "a", ["m1"])
  await Q.enqueue("ses_1", "/w", 1, "b", ["m1"])
  expect(await Q.pending("ses_1")).toEqual([{ session: "ses_1", seq: 1, body: "b" }])
  expect((await Q.cursor("ses_1"))!.sent).toEqual(["m1"])
})

test("corrupt cursor reads as undefined", async () => {
  await Q.enqueue("ses_3", "/w", 1, "{}", [])
  await fs.writeFile(path.join(Q.dir(), "ses_3", "cursor.json"), "{nope")
  expect(await Q.cursor("ses_3")).toBeUndefined()
})

test("session ids that are not plain names are refused", async () => {
  await expect(Q.enqueue("../x", "/w", 1, "{}", [])).rejects.toThrow()
})

test("backoff", () => {
  expect(Q.backoff(0)).toBeGreaterThanOrEqual(1000)
  expect(Q.backoff(0)).toBeLessThanOrEqual(1200)
  expect(Q.backoff(20)).toBeLessThanOrEqual(720_000)
  expect(Q.backoff(20)).toBeGreaterThanOrEqual(600_000)
})
