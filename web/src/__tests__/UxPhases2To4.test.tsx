import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  getInitials,
  formatBadgeCount,
  formatDateAR,
  formatTimeAR,
  formatCurrencyAR,
  formatPluralAR,
} from '../lib/formatters';
import { DialogOverlay } from '../components/common/DialogOverlay';
import { Avatar } from '../components/ui/Avatar';
import { PetPhoto } from '../vet/vetkit';
import { useIsMobileViewport } from '../lib/useIsMobileViewport';
import type { Patient } from '../vet/data';

describe('UX Phases 2-4 — Formatters, Focus Trap, Fallbacks & Mobile Viewport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('formatters.ts', () => {
    it('computes grapheme-safe initials while ignoring honorifics and suffixes', () => {
      expect(getInitials('Dr. Juan Pérez')).toBe('JP');
      expect(getInitials('Dra. María Ángeles López Jr.')).toBe('ML');
      expect(getInitials('🐾')).toBe('🐾');
      expect(getInitials('🐾 Luna')).toBe('🐾L');
      expect(getInitials('Firulais')).toBe('F');
      expect(getInitials('   ', 'T')).toBe('T');
      expect(getInitials(null, 'SA')).toBe('SA');
    });

    it('caps badge counts cleanly and handles invalid or null counts', () => {
      expect(formatBadgeCount(0)).toBe('0');
      expect(formatBadgeCount(undefined)).toBe('0');
      expect(formatBadgeCount(Number.NaN)).toBe('0');
      expect(formatBadgeCount(12)).toBe('12');
      expect(formatBadgeCount(99)).toBe('99');
      expect(formatBadgeCount(124)).toBe('99+');
    });

    it('formats es-AR dates, times, currency, and plurals safely on malformed inputs', () => {
      expect(formatDateAR('bad-date')).toBe('—');
      expect(formatDateAR(null)).toBe('—');
      expect(formatDateAR('2026-04-15T14:30:00Z')).not.toBe('—');
      expect(formatDateAR('2026-04-15T14:30:00Z', true)).toMatch(/15/);

      expect(formatTimeAR('not-a-time')).toBe('—');
      expect(formatTimeAR('2026-04-15T14:30:00Z')).not.toBe('—');

      expect(formatCurrencyAR(Number.NaN)).toBe('—');
      expect(formatCurrencyAR(25000, 'ARS')).toContain('25.000');

      expect(formatPluralAR(1, 'activa', 'activas')).toBe('1 activa');
      expect(formatPluralAR(3, 'activa', 'activas')).toBe('3 activas');
    });
  });

  describe('DialogOverlay focus trap and Escape restoration', () => {
    it('traps Tab/Shift+Tab inside dialog, handles Escape, and restores trigger focus on close', async () => {
      function Harness() {
        const [open, setOpen] = useState(false);
        return (
          <div>
            <button data-testid="trigger-btn" onClick={() => setOpen(true)}>
              Abrir diálogo
            </button>
            <DialogOverlay open={open} onClose={() => setOpen(false)} ariaLabel="Prueba modal">
              <button data-testid="first-btn">Primero</button>
              <button data-testid="last-btn" onClick={() => setOpen(false)}>
                Cerrar
              </button>
            </DialogOverlay>
          </div>
        );
      }

      render(<Harness />);
      const trigger = screen.getByTestId('trigger-btn');
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      fireEvent.click(trigger);

      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByTestId('first-btn'));
      });

      const first = screen.getByTestId('first-btn');
      const last = screen.getByTestId('last-btn');

      // Shift+Tab from first element wraps to last
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);

      // Tab from last element wraps back to first
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: false });
      expect(document.activeElement).toBe(first);

      // Escape closes modal and restores trigger focus
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  describe('Broken image resilience', () => {
    it('falls back to initials on Avatar image load error', () => {
      render(
        <MemoryRouter>
          <Avatar src="https://example.com/broken.jpg" alt="Dr. Sofía Díaz" />
        </MemoryRouter>
      );
      const img = screen.getByRole('img');
      fireEvent.error(img);
      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.getByText('SD')).toBeTruthy();
    });

    it('falls back to initials on Vet PetPhoto load error', () => {
      const pet: Patient = {
        id: 'pet-1',
        name: 'Toby',
        kind: 'Canino',
        breed: 'Mestizo',
        age: '3 años',
        weight: '12 kg',
        sex: 'Macho',
        chip: '—',
        tutor: 'Ana Pérez',
        tutorPhone: '1155550000',
        tutorEmail: 'ana@test.com',
        state: 'Activo',
        last: 'Hoy',
        lastDays: 0,
        photo: 'https://example.com/pet-broken.png',
        allergies: [],
        meds: [],
        history: [],
        vaccines: [],
        past: [],
        docs: [],
        studies: [],
        evolution: [],
      };
      render(<PetPhoto pet={pet} size={44} />);
      const img = document.querySelector('img.v-pet-photo');
      expect(img).not.toBeNull();
      fireEvent.error(img!);
      expect(document.querySelector('img.v-pet-photo')).toBeNull();
      expect(screen.getByText('T')).toBeTruthy();
    });
  });

  describe('useIsMobileViewport', () => {
    it('safely defaults to false in jsdom without throwing', () => {
      function Probe() {
        const isMobile = useIsMobileViewport();
        return <span data-testid="probe">{String(isMobile)}</span>;
      }
      render(<Probe />);
      expect(screen.getByTestId('probe').textContent).toBe('false');
    });
  });
});
