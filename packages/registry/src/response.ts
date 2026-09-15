/**
 * Every response this Worker emits — success and failure — is `application/json`.
 *
 * DEVIATION TO NOTE AT REVIEW (contracts §4.3): `packages/console/function/src/stat.ts`'s
 * precedent returns a plain-text 405 body (`new Response("Method Not Allowed", { status: 405 })`).
 * This package keeps that STATUS CODE but uses the JSON envelope for the body, so no client
 * ever has to branch on content type. The `Allow: GET` header is added per RFC 9110's
 * requirement on 405. No `Cache-Control` in v1.
 */

/**
 * The ONLY error body shape in this API (GAP-003). `message` is always a fixed,
 * caller-safe string — never a raw exception or D1 error message, which can leak SQL
 * and schema details.
 */
export function errorResponse(status: number, message: string, headers?: HeadersInit): Response {
  return Response.json({ error: message }, { status, headers })
}

export const badRequest = (message: string) => errorResponse(400, message)
export const notFound = () => errorResponse(404, "Not Found")
export const methodNotAllowed = () => errorResponse(405, "Method Not Allowed", { Allow: "GET" })
export const internalError = () => errorResponse(500, "Internal Server Error")
