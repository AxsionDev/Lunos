import { render, screen } from '@testing-library/angular';
import { FooterComponent } from './footer.component';

describe('FooterComponent', () => {
  it('renders the footer content', async () => {
    await render(FooterComponent);
    expect(screen.getByText(/lunos · lunos\.tech/i)).toBeTruthy();
  });
});
