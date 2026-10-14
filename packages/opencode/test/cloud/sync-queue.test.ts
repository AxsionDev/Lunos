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

test("a different body for a taken seq throws; identical bytes are a no-op", async () => {
  await Q.enqueue("ses_1", "/w", 1, "a", ["m1"])
  await expect(Q.enqueue("ses_1", "/w", 1, "b", ["m1"])).rejects.toBeInstanceOf(Q.SeqTakenError)
  expect(await Q.enqueue("ses_1", "/w", 1, "a", ["m1"])).toBe(true)
  expect(await Q.pending("ses_1")).toEqual([{ session: "ses_1", seq: 1, body: "a" }])
  expect((await Q.cursor("ses_1"))!.sent).toEqual(["m1"])
})

test("concurrent enqueues of different seqs both land", async () => {
  await Promise.all([1, 2, 3, 4, 5].map((seq) => Q.enqueue("ses_1", "/w", seq, `{"s":${seq}}`, [`m${seq}`])))
  expect((await Q.pending("ses_1")).map((p) => p.seq)).toEqual([1, 2, 3, 4, 5])
  const c = (await Q.cursor("ses_1"))!
  expect(c.seq).toBe(5)
  expect([...c.sent].sort()).toEqual(["m1", "m2", "m3", "m4", "m5"])
})

test("a stale lock is broken", async () => {
  await Q.enqueue("ses_1", "/w", 1, "a", [])
  const lock = path.join(Q.dir(), "ses_1", ".lock")
  await fs.writeFile(lock, "{}")
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(lock, old, old)
  expect(await Q.enqueue("ses_1", "/w", 2, "b", [])).toBe(true)
  await expect(fs.stat(lock)).rejects.toThrow()
})

test("enqueue after drop writes nothing and returns false", async () => {
  await Q.enqueue("ses_1", "/w", 1, "a", [])
  await Q.drop("ses_1", "denied")
  expect(await Q.enqueue("ses_1", "/w", 2, "b", [])).toBe(false)
  expect(await Q.pending("ses_1")).toEqual([])
})

test("no temp or lock files are left behind", async () => {
  await Q.enqueue("ses_1", "/w", 1, "a", [])
  await Q.ack("ses_1", 1)
  expect((await fs.readdir(path.join(Q.dir(), "ses_1"))).sort()).toEqual(["cursor.json"])
})

test("a shape-invalid cursor reads as undefined", async () => {
  await Q.enqueue("ses_1", "/w", 1, "a", [])
  const file = path.join(Q.dir(), "ses_1", "cursor.json")
  for (const bad of [{ session: "ses_1", directory: "/w", seq: -1, sent: [] }, { session: "ses_1", directory: "/w", seq: 1.5, sent: [] }, { session: "ses_1", directory: "/w", seq: 1, sent: [1] }, { session: "ses_1", seq: 1, sent: [] }, null]) {
    await fs.writeFile(file, JSON.stringify(bad))
    expect(await Q.cursor("ses_1")).toBeUndefined()
  }
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

test("reset deletes every chunk and rewinds the cursor to seq with nothing sent", async () => {
  for (const seq of [1, 2, 3]) await Q.enqueue("ses_1", "/w", seq, `{"s":${seq}}`, [`m${seq}`])
  await Q.reset("ses_1", 1)
  expect(await Q.pending("ses_1")).toEqual([])
  expect(await Q.cursor("ses_1")).toEqual({ session: "ses_1", directory: "/w", seq: 1, sent: [] })
  // The rebuilt chunks start right after it.
  expect(await Q.enqueue("ses_1", "/w", 2, "new", ["m1", "m2"])).toBe(true)
  expect((await fs.readdir(path.join(Q.dir(), "ses_1"))).filter((n) => n.endsWith(".lock") || n.endsWith(".tmp"))).toEqual([])
})
