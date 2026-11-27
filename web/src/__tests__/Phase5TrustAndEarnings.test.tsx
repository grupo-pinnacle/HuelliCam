import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { VetEarningsPage } from '../vet/Admin';
import { VerifyEmailBanner, TelemedicineConsentModal } from '../pages/ClientApp';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../services/api', () => ({
  default: {
    get: (...args: unknown[]) => apiGetMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
    defaults: { baseURL: 'http://localhost:3001' },
  },
}));

const refreshSessionMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'user-p5',
      email: 'ana@test.com',
      firstName: 'Ana',
      lastName: 'Pérez',
      role: 'CLIENT',
      emailVerified: false,
    },
    refreshSession: refreshSessionMock,
  }),
}));

describe('Phase 5 Trust, Verification, Consent & PagoFlex Earnings UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits 6-digit OTP verification in VerifyEmailBanner via POST /api/auth/verify-email', async () => {
    apiPostMock.mockResolvedValue({ data: { success: true, data: { emailVerified: true } } });

    render(<VerifyEmailBanner />);

    const input = screen.getByPlaceholderText(/Código de 6 dígitos/i);
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Verificar correo/i }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/auth/verify-email', { code: '123456' });
    });
  });

  it('records telemedicine informed consent in TelemedicineConsentModal', async () => {
    apiPostMock.mockResolvedValue({ data: { success: true, data: { id: 'c1', version: '1.0' } } });
    const onAccepted = vi.fn();

    render(
      <TelemedicineConsentModal
        open={true}
        onClose={vi.fn()}
        onAccepted={onAccepted}
      />
    );

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: /Aceptar y continuar/i }));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/api/users/telemedicine-consent', { version: '1.0' });
      expect(onAccepted).toHaveBeenCalled();
    });
  });

  it('renders simulated PagoFlex-ready ledger in VetEarningsPage', async () => {
    apiGetMock.mockResolvedValue({
      data: {
        success: true,
        data: {
          totalGrossCents: 15000,
          totalFeeCents: 3000,
          totalNetCents: 12000,
          currency: 'ARS',
          mode: 'SIMULATED_PAGOFLEX_PREP',
          entries: [
            {
              id: 'led-1',
              consultationId: 'cons-12345678',
              grossCents: 15000,
              platformFeeCents: 3000,
              netCents: 12000,
              currency: 'ARS',
              status: 'SIMULATED',
              provider: 'SIMULATED_NOOP',
              settledAt: null,
              createdAt: '2026-11-27T14:00:00.000Z',
            },
          ],
        },
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <VetEarningsPage />
      </QueryClientProvider>
    );

    expect(await screen.findByText(/Honorarios/i)).toBeDefined();
    expect(await screen.findByText(/Consulta #cons-123/i)).toBeDefined();
    expect(screen.getByText(/SIMULATED_PAGOFLEX_PREP/i)).toBeDefined();
  });
});
