---
name: project-lunos-web-page-specs
description: TestBed specs for marketing page components that render NavBarComponent need provideRouter([]) — discovered in Task 8.
metadata:
  type: project
---

Any spec that renders a full marketing page component (one whose template includes
`<lunos-nav-bar>`) via raw `TestBed.configureTestingModule({ imports: [...] })` needs
`providers: [provideRouter([])]` (from `@angular/router`), or `TestBed.createComponent`
throws `NG0201: No provider found for ActivatedRoute` — `NavBarComponent`
(`Lunos.Web/src/app/shared/nav-bar/nav-bar.component.ts`) uses `RouterLink`, which needs
router DI tokens that a bare TestBed module doesn't supply.

**Why:** discovered in Task 8 writing `contact.component.spec.ts` — the task brief's
literal spec code (raw `TestBed`, no router providers) failed with this DI error even
though the component and test logic were otherwise correct. The existing shared-component
specs (`nav-bar.component.spec.ts`, etc.) never hit this because they use
`@testing-library/angular`'s `render()` helper directly on `NavBarComponent`, not on a
page that embeds it via `TestBed`.

**How to apply:** for any future page-component spec (any marketing page under
`features/marketing/*`) that uses raw `TestBed.configureTestingModule` rather than
`@testing-library/angular`'s `render()`, add `provideRouter([])` up front — don't wait to
hit the DI error first. See [[project-lunos-web-verification]] for the related
`fileReplacements`/`tsc --noEmit` verification gotchas from the same task sequence.
