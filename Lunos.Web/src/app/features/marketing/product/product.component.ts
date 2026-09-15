import { Component } from '@angular/core';
import { NavBarComponent } from '../../../shared/nav-bar/nav-bar.component';
import { FooterComponent } from '../../../shared/footer/footer.component';

@Component({
  selector: 'lunos-product',
  standalone: true,
  imports: [NavBarComponent, FooterComponent],
  template: `
    <lunos-nav-bar />
    <main>
      <h1>Product</h1>
      <!-- COPY PENDING: parity table rows sourced from product-vision-roadmap.md, not reproduced in the PRD/tech spec doc set this plan was built from. -->
    </main>
    <lunos-footer />
  `,
})
export class ProductComponent {}
