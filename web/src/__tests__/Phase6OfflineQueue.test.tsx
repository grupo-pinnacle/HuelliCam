import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OfflineBanner from '../components/common/OfflineBanner';
import { WhatsAppCheck } from '../components/call/WhatsAppCheck';
import {
  enqueueOfflineMutation,
  flushOfflineQueue,
  getOfflineQueue,
} from '../lib/offlineQueue';

const requestMock = vi.fn();

vi.mock('../services/api', () => ({
  default: {
    request: (...args: unknown[]) => requestMock(...args),
  },
}));

describe('Phase 6 Offline Queue & WhatsAppCheck failed state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: true,
    });
  });

  it('queues failed mutations and flushes them when reconnected', async () => {
    enqueueOfflineMutation({
      method: 'PUT',
      url: '/api/notifications/preferences',
      data: { pushEnabled: true },
    });
    expect(getOfflineQueue()).toHaveLength(1);

    requestMock.mockResolvedValueOnce({ data: { success: true } });

    render(<OfflineBanner />);
    const retryBtn = await screen.findByRole('button', { name: /Reintentar ahora/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith({
        method: 'PUT',
        url: '/api/notifications/preferences',
        data: { pushEnabled: true },
      });
      expect(getOfflineQueue()).toHaveLength(0);
    });
  });

  it('retries failed mutations up to cap inside flushOfflineQueue', async () => {
    enqueueOfflineMutation({
      method: 'PATCH',
      url: '/api/consultations/c1/complete',
      data: { diagnosisNotes: 'Finalizada' },
    });
    requestMock.mockRejectedValue(new Error('Network error'));

    const res = await flushOfflineQueue();
    expect(res.flushed).toBe(0);
    expect(res.remaining).toBe(1);
    expect(getOfflineQueue()[0].retries).toBe(1);
  });

  it('renders clear failed indicator on WhatsAppCheck when state is failed', () => {
    render(<WhatsAppCheck state="failed" />);
    expect(screen.getByLabelText('Error al enviar')).toBeDefined();
  });
});
