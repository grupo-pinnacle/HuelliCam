import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrescriptionDetail } from '../vet/Prescriptions';
import api from '../services/api';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'vet-1',
      role: 'VET',
      firstName: 'Carlos',
      lastName: 'Mendoza',
      licenseNumber: 'MP-8921',
    },
  }),
}));

const mockSetRx = vi.fn();
const mockNotify = vi.fn();
const stableVetContext = {
  rx: [],
  setRx: mockSetRx,
  notify: mockNotify,
  consults: [],
  patientsList: [],
};

vi.mock('../vet/vetkit', async () => {
  const actual = await vi.importActual<typeof import('../vet/vetkit')>('../vet/vetkit');
  return {
    ...actual,
    useVet: () => stableVetContext,
  };
});

describe('Vet PrescriptionDetail — QR real del backend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renderiza la imagen real qrCodeDataUrl y el enlace verifyUrl devueltos por el backend (sin SVG conceptual)', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        success: true,
        data: {
          id: 'rx-real-uuid-1',
          consultationId: 'cons-1',
          vetId: 'vet-1',
          medication: 'Meloxicam 1,5 mg/ml',
          dosage: '0,2 ml',
          frequency: 'Cada 24 hs',
          durationDays: 5,
          indications: 'Administrar después de comer',
          createdAt: '2026-11-13T00:00:00.000Z',
          qrCodeDataUrl: 'data:image/png;base64,REALQRDATA',
          verifyUrl: 'http://localhost:5173/prescriptions/rx-real-uuid-1',
          consultation: {
            petId: 'pet-1',
            pet: { id: 'pet-1', name: 'Milo', species: 'Canine', breed: 'Labrador' },
            client: { id: 'client-1', firstName: 'Ana', lastName: 'Pérez' },
          },
        },
      },
    });

    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <PrescriptionDetail id="rx-real-uuid-1" />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      const qrImg = screen.getByTestId('vet-prescription-qr') as HTMLImageElement;
      expect(qrImg.tagName).toBe('IMG');
      expect(qrImg.src).toContain('data:image/png;base64,REALQRDATA');
    });

    const verifyLink = screen.getByRole('link', {
      name: 'http://localhost:5173/prescriptions/rx-real-uuid-1',
    });
    expect(verifyLink.getAttribute('href')).toBe('http://localhost:5173/prescriptions/rx-real-uuid-1');
    expect(screen.queryByLabelText('Código de referencia conceptual')).toBeNull();
  });
});
