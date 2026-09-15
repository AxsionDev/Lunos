import { render, screen } from '@testing-library/angular';
import { NavBarComponent } from './nav-bar.component';

describe('NavBarComponent', () => {
  it('does not render a Marketplace link in Phase 1', async () => {
    await render(NavBarComponent);
    expect(screen.queryByText(/marketplace/i)).toBeNull();
  });

  it('renders the wordmark and a mono install CTA', async () => {
    await render(NavBarComponent);
    expect(screen.getByText('lunos')).toBeTruthy();
    expect(screen.getByText(/\$ install/i)).toBeTruthy();
  });
});
