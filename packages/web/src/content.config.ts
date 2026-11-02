import { defineCollection, z } from "astro:content"
import { i18nLoader } from "@astrojs/starlight/loaders"
import { glob } from "astro/loaders"
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema"
import en from "./content/i18n/en.json"

const custom = Object.fromEntries(Object.keys(en).map((key) => [key, z.string()]))

export const collections = {
  // XCOD-124: the Lunos build of the docs, written by lunos/prepare.ts from src/content/docs.
  docs: defineCollection({
    loader: glob({ base: "./src/content/lunos-docs", pattern: "**/[^_]*.{md,mdx}" }),
    schema: docsSchema(),
  }),
  i18n: defineCollection({
    loader: i18nLoader(),
    schema: i18nSchema({
      extend: z.object(custom).catchall(z.string()),
    }),
  }),
}
