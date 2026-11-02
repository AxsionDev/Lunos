import { Tabs as Kobalte } from "@kobalte/core/tabs"
import { onMount, Show, splitProps, type JSX } from "solid-js"
import type { ComponentProps, ParentProps, Component } from "solid-js"

export interface TabsProps extends ComponentProps<typeof Kobalte> {
  variant?: "normal" | "alt" | "pill" | "settings"
  orientation?: "horizontal" | "vertical"
}
export interface TabsListProps extends ComponentProps<typeof Kobalte.List> {}
export interface TabsTriggerProps extends ComponentProps<typeof Kobalte.Trigger> {
  classes?: {
    button?: string
  }
  hideCloseButton?: boolean
  closeButton?: JSX.Element
  onMiddleClick?: () => void
}
export interface TabsContentProps extends ComponentProps<typeof Kobalte.Content> {}

function TabsRoot(props: TabsProps) {
  const [split, rest] = splitProps(props, ["class", "classList", "variant", "orientation"])
  return (
    <Kobalte
      {...rest}
      orientation={split.orientation}
      data-component="tabs"
      data-variant={split.variant || "normal"}
      data-orientation={split.orientation || "horizontal"}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    />
  )
}

function TabsList(props: TabsListProps) {
  const [split, rest] = splitProps(props, ["class", "classList"])
  return (
    <Kobalte.List
      {...rest}
      data-slot="tabs-list"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    />
  )
}

function TabsTrigger(props: ParentProps<TabsTriggerProps>) {
  const [split, rest] = splitProps(props, [
    "class",
    "classList",
    "classes",
    "children",
    "closeButton",
    "hideCloseButton",
    "onMiddleClick",
  ])
  return (
    <div
      data-slot="tabs-trigger-wrapper"
      data-value={props.value}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      onMouseDown={(e) => {
        if (e.button === 1 && split.onMiddleClick) {
          e.preventDefault()
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && split.onMiddleClick) {
          e.preventDefault()
          split.onMiddleClick()
        }
      }}
      onKeyDown={(e) => {
        // Keyboard close for closable tabs: the close button itself is hidden from the tab order below.
        if (e.key !== "Delete" || !split.onMiddleClick || e.defaultPrevented) return
        if (!(e.target instanceof Element) || e.target.getAttribute("role") !== "tab") return
        e.preventDefault()
        split.onMiddleClick()
      }}
    >
      <Kobalte.Trigger
        {...rest}
        dir={rest.dir ?? "auto"}
        data-slot="tabs-trigger"
        data-value={props.value}
        classList={{ [split.classes?.button ?? ""]: split.classes?.button }}
      >
        {split.children}
      </Kobalte.Trigger>
      <Show when={split.closeButton}>
        {(closeButton) => (
          <div
            data-slot="tabs-trigger-close-button"
            data-hidden={split.hideCloseButton}
            // A tablist may only own tabs (XCOD-141, axe aria-required-children), so the close button
            // is a pointer affordance only: hidden from assistive tech and the tab order. Keyboard users
            // close the focused tab with Delete (above) or the close-tab shortcut.
            aria-hidden="true"
            ref={(el) =>
              onMount(() => {
                for (const node of el.querySelectorAll<HTMLElement>("button, a[href], input, [tabindex]"))
                  node.tabIndex = -1
              })
            }
          >
            {closeButton()}
          </div>
        )}
      </Show>
    </div>
  )
}

function TabsContent(props: ParentProps<TabsContentProps>) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Content
      {...rest}
      data-slot="tabs-content"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </Kobalte.Content>
  )
}

const TabsSectionTitle: Component<ParentProps> = (props) => {
  return <div data-slot="tabs-section-title">{props.children}</div>
}

export const Tabs = Object.assign(TabsRoot, {
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
  SectionTitle: TabsSectionTitle,
})
