import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-about',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>About</h1>
      <!-- COPY PENDING: project background copy not drafted in the PRD/tech spec. -->
    </main>
    <lunos-footer />
  `,
})
export class AboutComponent {}
