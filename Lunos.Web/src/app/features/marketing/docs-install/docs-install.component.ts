import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-docs-install',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>Install</h1>
      <pre class="install-cmd">curl -fsSL https://lunos.tech/install.sh | sh</pre>
      <!-- COPY PENDING: terminal recording/GIF — PRD §7 calls this the single highest-leverage marketing asset; don't ship this page without it. Needs an actual recorded install session, not a placeholder image. -->
    </main>
    <lunos-footer />
  `,
  styles: `.install-cmd { font-family: var(--font-mono); background: var(--mantle); color: var(--green); padding: 1rem; border-radius: 6px; }`,
})
export class DocsInstallComponent {}
