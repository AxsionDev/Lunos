import { render, screen } from '@testing-library/angular';
import { SovereigntyStripComponent } from './sovereignty-strip.component';

describe('SovereigntyStripComponent', () => {
  it('renders the provided statement', async () => {
    await render(SovereigntyStripComponent, {
      inputs: { statement: 'Your code, your infrastructure, your rules.' },
    });
    expect(screen.getByText('Your code, your infrastructure, your rules.')).toBeTruthy();
  });
});
