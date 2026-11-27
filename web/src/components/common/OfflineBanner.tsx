import React, { useState, useEffect, useRef } from 'react';
import { WifiOff, Wifi } from 'lucide-react';
import { flushOfflineQueue, subscribeOfflineQueue } from '../../lib/offlineQueue';

export const OfflineBanner: React.FC = () => {
  const [isOffline, setIsOffline] = useState<boolean>(() => {
    return typeof navigator !== 'undefined' ? !navigator.onLine : false;
  });
  const [reconnected, setReconnected] = useState<boolean>(false);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeOfflineQueue((items) => {
      setPendingCount(items.length);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const handleOffline = () => {
      clearTimer();
      setIsOffline(true);
      setReconnected(false);
    };

    const handleOnline = () => {
      clearTimer();
      setIsOffline(false);
      setReconnected(true);
      void flushOfflineQueue();
      timerRef.current = window.setTimeout(() => {
        setReconnected(false);
        timerRef.current = null;
      }, 3500);
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      clearTimer();
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  if (!isOffline && !reconnected && pendingCount === 0) {
    return null;
  }

  if (reconnected) {
    return (
      <aside
        role="status"
        aria-live="polite"
        data-testid="online-reconnected-banner"
        className="w-full bg-[#315f5d] text-[#fffbef] px-4 py-2.5 text-xs font-bold flex items-center justify-center gap-2 shadow-sm animate-fadeIn z-50 sticky top-0 font-['Manrope',sans-serif]"
      >
        <Wifi className="w-3.5 h-3.5 text-[#d9e8e4]" aria-hidden="true" />
        <span>Conexión restablecida — Sincronizando datos con la red de HuelliCam...</span>
      </aside>
    );
  }

  if (!isOffline && pendingCount > 0) {
    return (
      <aside
        role="status"
        aria-live="polite"
        className="w-full bg-[#fffbeb] text-[#183c3a] px-4 py-2 text-xs font-bold flex items-center justify-center gap-3 shadow-sm z-50 sticky top-0 border-b border-[#f59e0b]/40 font-['Manrope',sans-serif]"
      >
        <span>Hay {pendingCount} cambio(s) pendiente(s) por sincronizar.</span>
        <button
          type="button"
          onClick={() => void flushOfflineQueue()}
          className="rounded-lg bg-[#183c3a] px-2.5 py-1 text-[11px] font-extrabold text-white"
        >
          Reintentar ahora
        </button>
      </aside>
    );
  }

  return (
    <aside
      role="alert"
      aria-live="assertive"
      data-testid="offline-network-banner"
      className="w-full bg-[#fbeee9] text-[#183c3a] px-4 py-2.5 text-xs font-bold flex items-center justify-center gap-2 shadow-sm animate-fadeIn z-50 sticky top-0 border-b border-[#e98b70]/45 font-['Manrope',sans-serif]"
    >
      <WifiOff className="w-4 h-4 text-[#ae4d45] shrink-0" aria-hidden="true" />
      <span>
        Sin conexión a internet — Reconectando automáticamente al restablecerse el enlace
        {pendingCount > 0 ? ` (${pendingCount} acción/es en cola)...` : '...'}
      </span>
    </aside>
  );
};

export default OfflineBanner;
