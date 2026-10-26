// Prints the skill list as JSON, like `lunos debug skill`.
const skills = Array.from({ length: 4000 }, (_, i) => ({
  name: `skill-${i}`,
  description: `Description for skill ${i}: ${"lorem ipsum ".repeat(6)}`,
}))

process.stdout.write(JSON.stringify(skills, null, 2) + "\n")
process.exit(0)
