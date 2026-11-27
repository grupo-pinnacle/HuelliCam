import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { NewPetModal } from '../pages/ClientApp';
import api from '../services/api';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
  getAccessToken: vi.fn(() => 'mock-token'),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', firstName: 'Lucia', lastName: 'Perez', role: 'CLIENT' },
    refreshSession: vi.fn(),
    logout: vi.fn(),
  }),
}));

describe('FEAT-02: Opción "No sé" en Peso de Mascota', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe('NewPetModal (ClientApp.tsx)', () => {
    it('disables and clears weight input when "No sé el peso exacto" checkbox is toggled', () => {
      render(
        <QueryClientProvider client={queryClient}>
          <NewPetModal open={true} onClose={vi.fn()} />
        </QueryClientProvider>
      );

      const weightInput = screen.getByTestId('input-pet-weight') as HTMLInputElement;
      const unknownCheckbox = screen.getByTestId('checkbox-unknown-weight') as HTMLInputElement;

      // Initially enabled and empty
      expect(weightInput.disabled).toBe(false);
      expect(unknownCheckbox.checked).toBe(false);

      // Enter weight
      fireEvent.change(weightInput, { target: { value: '14.5' } });
      expect(weightInput.value).toBe('14.5');

      // Check "No sé el peso exacto"
      fireEvent.click(unknownCheckbox);

      expect(unknownCheckbox.checked).toBe(true);
      expect(weightInput.disabled).toBe(true);
      expect(weightInput.value).toBe('');
      expect(weightInput.placeholder).toBe('Sin especificar');

      // Uncheck "No sé el peso exacto"
      fireEvent.click(unknownCheckbox);
      expect(unknownCheckbox.checked).toBe(false);
      expect(weightInput.disabled).toBe(false);
    });

    it('submits with weightKg: undefined when "No sé el peso exacto" is checked', async () => {
      (api.post as any).mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            id: 'pet-new-001',
            name: 'Pipo',
            species: 'Perro',
            breed: 'Mestizo / Criollo',
            weightKg: null,
          },
        },
      });

      render(
        <QueryClientProvider client={queryClient}>
          <NewPetModal open={true} onClose={vi.fn()} />
        </QueryClientProvider>
      );

      // Fill required pet name
      const nameInput = screen.getByPlaceholderText('Ej: Milo');
      fireEvent.change(nameInput, { target: { value: 'Pipo' } });

      // Check "No sé el peso exacto"
      const unknownCheckbox = screen.getByTestId('checkbox-unknown-weight');
      fireEvent.click(unknownCheckbox);

      // Save pet
      const saveBtn = screen.getByRole('button', { name: /Guardar mascota/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(api.post).toHaveBeenCalledWith(
          '/api/pets',
          expect.objectContaining({
            name: 'Pipo',
            species: 'Perro',
            weightKg: undefined,
          })
        );
      });
    });
  });
});
