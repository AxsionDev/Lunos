import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-license',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>License</h1>
      <!-- BLOCKED: license text cannot be written until the license decision (PRD §12 / tech spec §13) is made. Do not guess a license here. -->
    </main>
    <lunos-footer />
  `,
})
export class LicenseComponent {}
