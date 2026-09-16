import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';
import { SovereigntyStripComponent } from '../../../shared/sovereignty-strip/sovereignty-strip.component';

@Component({
  selector: 'lunos-sovereignty',
  standalone: true,
  imports: [NavBarComponent, FooterComponent, SovereigntyStripComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>Sovereignty & Compliance</h1>
      <lunos-sovereignty-strip
        statement="lunos.tech runs on self-hosted EU infrastructure — the same sovereignty guarantee the project ships to its users." />
      <!-- COPY PENDING: detailed compliance narrative beyond the strip statement not drafted in the PRD/tech spec. -->
    </main>
    <lunos-footer />
  `,
})
export class SovereigntyComponent {}
