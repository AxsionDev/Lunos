import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "tech.lunos.desktop" : `tech.lunos.desktop.${channel}`
const productName = channel === "prod" ? "Lunos" : `Lunos ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `Open source AI coding agent${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="tech.lunos">
    <name>ITService EOOD (Axsion)</name>
  </developer>

  <description>
    <p>
      Lunos is an EU-sovereign, self-hostable AI coding agent that works with the model provider you choose. It is a fork of opencode.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/AxsionDev/Lunos/issues</url>
  <url type="homepage">https://lunos.tech</url>
  <url type="vcs-browser">https://github.com/AxsionDev/Lunos</url>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
