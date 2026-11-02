// The memory sidecar and its lock file are shipped inside the binary as text (XCOD-94).
declare module "*.py" {
  const content: string
  export default content
}
declare module "*.py.lock" {
  const content: string
  export default content
}
