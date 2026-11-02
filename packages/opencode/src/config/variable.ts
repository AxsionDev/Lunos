export * as ConfigVariable from "./variable"

import path from "path"
import os from "os"
import { Filesystem } from "@/util/filesystem"
import { InvalidError } from "@opencode-ai/core/v1/config/error"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  missing?: "error" | "empty"
  env?: Record<string, string>
  /**
   * XCOD-151: "json" (default) when `text` is a JSON/JSONC document: a value placed inside a string
   * literal is escaped, so a secret holding `"`, `\` or a newline neither breaks the document nor
   * changes. "plain" when `text` is already a value (a URL, a header): inserted as is.
   */
  into?: "json" | "plain"
}

/**
 * Whether `index` in a JSONC document falls inside a string literal. Comments are skipped, so a
 * quote in one doesn't flip the state.
 */
export function insideString(text: string, index: number) {
  let inString = false
  for (let i = 0; i < index; i++) {
    const char = text[i]
    if (inString) {
      if (char === "\\") i++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i)
      if (end === -1 || end >= index) return false
      i = end
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      if (end === -1 || end >= index) return false
      i = end + 1
    }
  }
  return inString
}

/** The value as it must appear at `index`: escaped inside a JSON string literal, as is elsewhere. */
function place(value: string, text: string, index: number, into: "json" | "plain") {
  return into === "json" && insideString(text, index) ? JSON.stringify(value).slice(1, -1) : value
}

function source(input: ParseSource) {
  return input.type === "path" ? input.path : input.source
}

function dir(input: ParseSource) {
  return input.type === "path" ? path.dirname(input.path) : input.dir
}

/** Apply {env:VAR} and {file:path} substitutions to config text. */
export async function substitute(input: SubstituteInput) {
  const missing = input.missing ?? "error"
  const into = input.into ?? "json"
  let text = input.text.replace(/\{env:([^}]+)\}/g, (_, varName: string, index: number) =>
    place((input.env?.[varName] ?? process.env[varName]) || "", input.text, index, into),
  )

  const fileMatches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
  if (!fileMatches.length) return text

  const configDir = dir(input)
  const configSource = source(input)
  let out = ""
  let cursor = 0

  for (const match of fileMatches) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    let filePath = token.replace(/^\{file:/, "").replace(/\}$/, "")
    if (filePath.startsWith("~/")) {
      filePath = path.join(os.homedir(), filePath.slice(2))
    }

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
    const fileContent = (
      await Filesystem.readText(resolvedPath).catch((error: NodeJS.ErrnoException) => {
        if (missing === "empty") return ""

        const errMsg = `bad file reference: "${token}"`
        if (error.code === "ENOENT") {
          throw new InvalidError(
            {
              path: configSource,
              message: errMsg + ` ${resolvedPath} does not exist`,
            },
            { cause: error },
          )
        }
        throw new InvalidError({ path: configSource, message: errMsg }, { cause: error })
      })
    ).trim()

    out += place(fileContent, text, index, into)
    cursor = index + token.length
  }

  out += text.slice(cursor)
  return out
}
