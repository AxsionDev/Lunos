import { expect, test } from "bun:test"
import { toData } from "../src/data"

test("groups messages and parts for DataProvider", () => {
  const m = (id: string, role: string, created: number) => ({ info: { id, sessionID: "ses_1", role, time: { created } }, parts: [{ id: `p_${id}`, type: "text", text: id }] })
  const { data, userMessageIDs } = toData({ id: "ses_1", title: "T" }, [m("b", "assistant", 2), m("a", "user", 1), m("c", "user", 3)] as any)
  expect(data.message["ses_1"]!.map((i: any) => i.id)).toEqual(["a", "b", "c"])
  expect((data.part["b"]![0] as any).text).toBe("b")
  expect(userMessageIDs).toEqual(["a", "c"])
  expect(data.session[0]).toMatchObject({ id: "ses_1", title: "T", directory: "" })
})

test("a session with no messages renders nothing and does not throw", () => {
  expect(toData({ id: "s" }, []).userMessageIDs).toEqual([])
})
