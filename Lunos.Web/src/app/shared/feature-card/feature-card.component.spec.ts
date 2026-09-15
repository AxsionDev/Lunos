import { render, screen } from '@testing-library/angular';
import { FeatureCardComponent } from './feature-card.component';

describe('FeatureCardComponent', () => {
  it('renders the phase tag, heading, and body', async () => {
    await render(FeatureCardComponent, {
      inputs: {
        phase: 'Phase 1',
        heading: 'Own your agent',
        body: 'Run the CLI on infrastructure you control.',
      },
    });
    expect(screen.getByText('Phase 1')).toBeTruthy();
    expect(screen.getByText('Own your agent')).toBeTruthy();
    expect(screen.getByText('Run the CLI on infrastructure you control.')).toBeTruthy();
  });
});
