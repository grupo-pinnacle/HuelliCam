import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  buildPrintableHtmlSnapshot,
  isReactNativeWebView,
  notifyMobileAuthLogout,
  notifyMobileAuthSession,
  postMobileBridgeMessage,
  requestMobileExternalOpen,
  requestMobilePrintOrFallback,
} from '../lib/mobileBridge';
import { PrescriptionDoc } from '../components/ui/PrescriptionDoc';
import { Prescription } from '../types';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

const samplePrescription: Prescription = {
  id: 'rx-mobile-1',
  consultationId: 'cons-1',
  vetId: 'vet-1',
  medication: 'Amoxicilina 250mg',
  dosage: '1 comprimido',
  frequency: 'Cada 12h',
  durationDays: 7,
  indications: 'Administrar con alimento.',
  createdAt: '2026-11-17T12:00:00.000Z',
  verifyUrl: '/prescriptions/rx-mobile-1',
};

describe('web/src/lib/mobileBridge', () => {
  const originalPrint = window.print;

  beforeEach(() => {
    delete window.ReactNativeWebView;
    window.print = vi.fn();
  });

  afterEach(() => {
    delete window.ReactNativeWebView;
    window.print = originalPrint;
  });

  it('detects ReactNativeWebView presence and drops messages safely outside WebView', () => {
    expect(isReactNativeWebView()).toBe(false);
    expect(postMobileBridgeMessage({ type: 'page:ready' })).toBe(false);
    expect(requestMobileExternalOpen('https://app.huellicam.com.ar')).toBe(false);
  });

  it('sends typed auth:session and auth:logout payloads inside WebView', () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };

    expect(isReactNativeWebView()).toBe(true);
    notifyMobileAuthSession('jwt-mobile-1', {
      id: 'u-1',
      email: 'tutor@huellicam.com.ar',
      firstName: 'Lara',
      lastName: 'Bouso',
      role: 'CLIENT',
    });
    notifyMobileAuthLogout();

    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: 'auth:session',
        token: 'jwt-mobile-1',
        user: {
          id: 'u-1',
          email: 'tutor@huellicam.com.ar',
          firstName: 'Lara',
          lastName: 'Bouso',
          role: 'CLIENT',
        },
      })
    );
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({ type: 'auth:logout' })
    );
  });

  it('falls back to window.print in standard web and delegates print:request in WebView', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>Receta Oficial</p>';

    requestMobilePrintOrFallback({ title: 'Receta', url: 'https://huellicam.com/rx', element: el });
    expect(window.print).toHaveBeenCalledTimes(1);

    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };

    requestMobilePrintOrFallback({ title: 'Receta', url: 'https://huellicam.com/rx', element: el });
    expect(window.print).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(postMessage.mock.calls[0][0] as string) as {
      type: string;
      title: string;
      url: string;
      html?: string;
    };
    expect(payload.type).toBe('print:request');
    expect(payload.title).toBe('Receta');
    expect(payload.html).toContain('Receta Oficial');
  });

  it('escapes HTML title in buildPrintableHtmlSnapshot and includes PrescriptionDoc bridge print', () => {
    const el = document.createElement('div');
    const html = buildPrintableHtmlSnapshot(el, '<Receta & "1">');
    expect(html).toContain('&lt;Receta &amp; &quot;1&quot;&gt;');

    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };

    render(<PrescriptionDoc prescription={samplePrescription} />);
    fireEvent.click(screen.getByTestId('print-prescription-button'));

    expect(window.print).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalled();
    const sent = JSON.parse(postMessage.mock.calls[0][0] as string) as {
      type: string;
      html?: string;
    };
    expect(sent.type).toBe('print:request');
    expect(sent.html).toContain('Amoxicilina 250mg');
  });
});
