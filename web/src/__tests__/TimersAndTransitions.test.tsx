import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let consultationData: Record<string, unknown> = {};

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(async (url: string) =>
      /\/api\/consultations\/c-timer$/.test(url)
        ? { data: { success: true, data: consultationData } }
        : { data: { success: true, data: [] } }
    ),
    post: vi.fn().mockResolvedValue({ data: { success: false } }),
    patch: vi.fn().mockResolvedValue({ data: { success: true } }),
    defaults: { baseURL: '' },
  },
  getAccessToken: () => 'tok',
  getDeviceId: () => 'dev',
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'CLIENT', firstName: 'Tobias', lastName: 'Vera' } }),
}));

vi.mock('../context/SocketContext', () => ({
  useSocket: () => ({
    socket: null,
    isConnected: false,
    reconnectingConsultations: {},
    joinConsultation: vi.fn(),
    leaveConsultation: vi.fn(),
    emitEvent: vi.fn(),
  }),
}));

vi.mock('socket.io-client', () => ({
  io: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn() }),
}));

vi.mock('@livekit/components-react', () => ({
  LiveKitRoom: () => null,
  VideoConference: () => null,
  useLocalParticipant: () => ({ localParticipant: null }),
}));

vi.mock('@livekit/components-styles', () => ({}));
vi.mock('../components/ui/ReviewModal', () => ({ ReviewModal: () => null }));
vi.mock('../vet/Consultations', () => ({
  EvolutionEditor: () => null,
  FichaClinica: () => null,
}));

import { WaitTimer } from '../vet/vetkit';
import CallRoom from '../vet/CallRoom';
import { Tabs, SectionStage } from '../shared';

describe('Synchronized timers & Emil Kowalski Tabs transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-27T18:30:00.000Z'));
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('WaitTimer syncs multiple mounted instances to createdAt instead of stale base', () => {
    const createdAt75sAgo = new Date(Date.now() - 75 * 1000).toISOString();

    const { rerender } = render(
      <div>
        <WaitTimer base={5} createdAt={createdAt75sAgo} />
      </div>
    );
    expect(screen.getByText('01:15')).toBeTruthy();

    // Simulate opening the Review Sheet 12 seconds later: both timers must show 01:27!
    vi.advanceTimersByTime(12 * 1000);
    rerender(
      <div>
        <WaitTimer base={5} createdAt={createdAt75sAgo} />
        <WaitTimer base={5} createdAt={createdAt75sAgo} />
      </div>
    );
    expect(screen.getAllByText('01:27')).toHaveLength(2);
  });

  it('CallRoom WaitingRoomExperience renders real elapsed wait time from createdAt (not 00:00)', async () => {
    vi.useRealTimers();
    const createdAt65sAgo = new Date(Date.now() - 65 * 1000).toISOString();
    consultationData = {
      id: 'c-timer',
      petId: 'p1',
      pet: { id: 'p1', name: 'Princesa', species: 'Perro' },
      client: { firstName: 'Tobias', lastName: 'Vera' },
      notes: '[Prioridad: ROJO] Dificultad para respirar',
      status: 'WAITING',
      createdAt: createdAt65sAgo,
      startedAt: null,
      vetId: null,
      vet: null,
    };
    window.history.pushState({}, '', '/call/c-timer?from=client');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <CallRoom id="c-timer" />
      </QueryClientProvider>
    );

    const timer = await screen.findByRole('timer', { name: 'Tiempo de espera' });
    await vi.waitFor(() => {
      expect(timer.textContent).toMatch(/^01:0[5-9]$/);
    });
  });

  it('Tabs renders sliding indicator and switches aria-selected + SectionStage cleanly', () => {
    function DemoTabs() {
      const [active, setActive] = React.useState('General');
      return (
        <div>
          <Tabs tabs={['General', 'Vacunación']} active={active} onChange={setActive} />
          <SectionStage stageKey={active}>
            <div data-testid="stage-body">{active}</div>
          </SectionStage>
        </div>
      );
    }

    const { container } = render(<DemoTabs />);
    expect(container.querySelector('.tabs__indicator')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('tab', { name: 'Vacunación' }));
    expect(screen.getByRole('tab', { name: 'Vacunación' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('stage-body').textContent).toBe('Vacunación');
  });
});
