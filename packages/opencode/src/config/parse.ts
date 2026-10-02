export * as ConfigParse from "./parse"

import { type ParseError as JsoncParseError, parse as parseJsoncImpl, printParseErrorCode } from "jsonc-parser"
import { Cause, Exit, Schema as EffectSchema, SchemaIssue } from "effect"
import type { DeepMutable } from "@opencode-ai/core/schema"
import { InvalidError, JsonError } from "@opencode-ai/core/v1/config/error"

export function jsonc(text: string, filepath: string): unknown {
  const errors: JsoncParseError[] = []
  const data = parseJsoncImpl(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const lines = text.split("\n")
    const issues = errors
      .map((e) => {
        const beforeOffset = text.substring(0, e.offset).split("\n")
        const line = beforeOffset.length
        const column = beforeOffset[beforeOffset.length - 1].length + 1
        const problemLine = lines[line - 1]

        const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
        if (!problemLine) return error

        return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
      })
      .join("\n")
    throw new JsonError({
      path: filepath,
      message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${issues}\n--- End ---`,
    })
  }

  return data
}

/**
 * XCOD-151: parse config text after {env:}/{file:} substitution, but never show it. An error is
 * reported against `original`, the text as written, where references are still `{env:NAME}`; if the
 * original parses, the substitution itself broke the document, and only the reference names are
 * given. The substituted text can hold secrets, so it never appears in an error.
 */
export function jsoncSubstituted(original: string, expanded: string, filepath: string): unknown {
  const errors: JsoncParseError[] = []
  const data = parseJsoncImpl(expanded, errors, { allowTrailingComma: true })
  if (!errors.length) return data
  jsonc(original, filepath)
  const references = Array.from(new Set(original.match(/\{(?:env|file):[^}]+\}/g) ?? []))
  throw new JsonError({
    path: filepath,
    message:
      `the file is valid as written, but not once ${references.join(", ") || "its references"} ` +
      "are filled in. A value placed outside a string must be valid JSON on its own (a number, true/false, an object); " +
      "put the reference inside quotes to use it as text.",
  })
}

export function schema<S extends EffectSchema.Decoder<unknown, never>>(
  schema: S,
  data: unknown,
  source: string,
): DeepMutable<S["Type"]> {
  const decoded = EffectSchema.decodeUnknownExit(schema)(data, {
    errors: "all",
    onExcessProperty: "ignore",
    propertyOrder: "original",
  })
  if (Exit.isSuccess(decoded)) return decoded.value as DeepMutable<S["Type"]>
  const error = Cause.squash(decoded.cause)

  throw new InvalidError(
    {
      path: source,
      issues: EffectSchema.isSchemaError(error)
        ? SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => ({
            ...issue,
            message: issue.message,
            path: issue.path?.map(String) ?? [],
          }))
        : [{ message: String(error), path: [] }],
    },
    { cause: error },
  )
}
