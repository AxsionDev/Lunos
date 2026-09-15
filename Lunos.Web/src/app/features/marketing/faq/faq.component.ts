import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-faq',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>FAQ</h1>
      <!-- COPY PENDING: "why fork opencode" and other FAQ entries not drafted in the PRD/tech spec — needs PO-approved copy per tech spec §13. -->
    </main>
    <lunos-footer />
  `,
})
export class FaqComponent {}
