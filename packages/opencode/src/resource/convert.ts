export * as ResourceConvert from "./convert"

import path from "node:path"
import { convertHTMLToMarkdown } from "@/tool/webfetch"

/**
 * Turning a file into text, locally (XCOD-300). Text, Markdown and source files are read as they
 * are; HTML goes through webfetch's Markdown conversion; PNG/JPG are images, attached for models
 * that take images. PDF and docx need a converter Lunos doesn't ship yet: they say so instead of
 * being indexed as noise. A PDF can still be attached as a file for models that read PDFs.
 */

export type Converted =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string }
  | { kind: "document"; mime: string; reason: string }
  | { kind: "skip"; reason: string }

export interface Converter {
  readonly extensions: readonly string[]
  convert(file: string, bytes: Uint8Array): Converted
}

export const IMAGE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" }

const html: Converter = {
  extensions: [".html", ".htm"],
  convert: (_file, bytes) => ({ kind: "text", text: convertHTMLToMarkdown(new TextDecoder().decode(bytes)) }),
}

const image: Converter = {
  extensions: Object.keys(IMAGE),
  convert: (file) => ({ kind: "image", mime: IMAGE[path.extname(file).toLowerCase()]! }),
}

export const NOT_YET = (kind: string) =>
  `${kind} files can't be converted to text yet: Lunos doesn't ship a ${kind} converter. Mention the resource with @name to attach it to a model that reads ${kind} files, or add a text or Markdown export instead`

const pdf: Converter = {
  extensions: [".pdf"],
  convert: () => ({ kind: "document", mime: "application/pdf", reason: NOT_YET("PDF") }),
}

const docx: Converter = {
  extensions: [".docx"],
  convert: () => ({
    kind: "skip",
    reason:
      "docx files can't be converted to text yet: Lunos doesn't ship a docx converter. Export it as Markdown or PDF instead",
  }),
}

/** Formats that are never text, so they're skipped without being read as such. */
const BINARY = new Set(
  ".gif .webp .bmp .ico .tif .tiff .svgz .zip .gz .tgz .bz2 .xz .7z .rar .jar .war .exe .dll .so .dylib .bin .o .a .class .pyc .wasm .mp3 .mp4 .mov .avi .wav .flac .ogg .woff .woff2 .ttf .otf .eot .doc .xls .xlsx .ppt .pptx .odt .sqlite .db".split(
    " ",
  ),
)

export const CONVERTERS: readonly Converter[] = [html, image, pdf, docx]

export function convert(file: string, bytes: Uint8Array): Converted {
  const ext = path.extname(file).toLowerCase()
  const converter = CONVERTERS.find((item) => item.extensions.includes(ext))
  if (converter) return converter.convert(file, bytes)
  if (BINARY.has(ext)) return { kind: "skip", reason: "binary file" }
  // A NUL in the first few KB means binary, as git decides it.
  if (bytes.subarray(0, 8000).includes(0)) return { kind: "skip", reason: "binary file" }
  return { kind: "text", text: new TextDecoder().decode(bytes) }
}
