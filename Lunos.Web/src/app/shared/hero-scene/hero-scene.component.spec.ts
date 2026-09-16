import { render, screen } from '@testing-library/angular';
import { HeroSceneComponent } from './hero-scene.component';

describe('HeroSceneComponent', () => {
  it('renders the wordmark and install terminal card', async () => {
    await render(HeroSceneComponent);
    expect(screen.getByText('lunos')).toBeTruthy();
    expect(screen.getByText(/curl -fsSL/i)).toBeTruthy();
  });
});
