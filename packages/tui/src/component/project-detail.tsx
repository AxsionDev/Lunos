// XCOD-306: what a row of the sidebar's Project section opens, and its Settings button.
import { useDialog } from "../ui/dialog"
import { DialogSettings } from "./dialog-settings"
import { DialogProject, DialogProjects } from "./dialog-projects"
import { DialogProjectResources, type useSessionProject } from "./project-section"

export function useProjectDetail() {
  const dialog = useDialog()
  return (target: string, project: ReturnType<typeof useSessionProject>) => {
    const ref = project.ref()
    if (!ref) return
    const scoped = { ref, directory: project.directory() }
    if (target === "project") {
      if (ref.kind === "named")
        return dialog.replace(() => <DialogProject id={ref.key} onBack={() => dialog.clear()} />)
      return dialog.replace(() => <DialogProjects select={ref.key} />)
    }
    if (target === "budget")
      return dialog.replace(() => <DialogSettings tab="settings" area="Projects" sub="Budgets" />)
    if (target === "resources")
      return dialog.replace(() => <DialogProjectResources list={project.resources()} name={ref.name} />)
    if (target === "memory") return dialog.replace(() => <DialogSettings tab="settings" area="Memory" />)
    if (target === "sandbox")
      return dialog.replace(() => <DialogSettings tab="settings" area="Permissions" sub="Sandbox" />)
    if (target === "theme")
      return dialog.replace(() => <DialogSettings tab="settings" project={scoped} focus="+project.theme" />)
    return dialog.replace(() => <DialogSettings tab="settings" project={scoped} />)
  }
}
