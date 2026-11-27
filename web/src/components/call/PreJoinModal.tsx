import React, { useRef, useState } from 'react';
import { useFocusTrap } from '../common/DialogOverlay';

interface PreJoinModalProps {
  onJoin: (audioEnabled: boolean, videoEnabled: boolean) => void;
  onCancel?: () => void;
}

export const PreJoinModal: React.FC<PreJoinModalProps> = ({ onJoin, onCancel }) => {
  const [audioEnabled, setAudioEnabled] = useState<boolean>(true);
  const [videoEnabled, setVideoEnabled] = useState<boolean>(true);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(true, dialogRef, { onEscape: onCancel });

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50 hc-dialog-backdrop"
      onMouseDown={(event) => {
        if (onCancel && event.target === event.currentTarget) onCancel();
      }}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="prejoin-title" className="bg-white rounded-xl max-w-md w-full p-6 shadow-2xl hc-dialog-panel">
        <h2 id="prejoin-title" className="text-xl font-bold text-slate-800 mb-2">
          Verificacion Previa de Camara y Microfono
        </h2>
        <p className="text-sm text-slate-600 mb-6">
          Asegurese de que sus dispositivos esten listos antes de ingresar a la consulta telemática.
        </p>

        <div className="space-y-4 mb-6">
          <label className="flex items-center justify-between p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
            <span className="text-sm font-medium text-slate-700">Microfono</span>
            <input
              type="checkbox"
              checked={audioEnabled}
              onChange={(e) => setAudioEnabled(e.target.checked)}
              className="w-4 h-4 text-sky-600 rounded focus:ring-sky-500"
            />
          </label>

          <label className="flex items-center justify-between p-3 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
            <span className="text-sm font-medium text-slate-700">Camara Web</span>
            <input
              type="checkbox"
              checked={videoEnabled}
              onChange={(e) => setVideoEnabled(e.target.checked)}
              className="w-4 h-4 text-sky-600 rounded focus:ring-sky-500"
            />
          </label>
        </div>

        <div className="flex gap-3">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-2.5 px-4 border border-slate-300 rounded-lg text-sm font-semibold text-slate-700 hover:bg-slate-50 active:scale-[0.97] transition-[transform,background-color] duration-150"
            >
              Cancelar
            </button>
          )}
          <button
            type="button"
            onClick={() => onJoin(audioEnabled, videoEnabled)}
            className="flex-1 py-2.5 px-4 bg-sky-600 rounded-lg text-sm font-semibold text-white hover:bg-sky-700 active:scale-[0.97] transition-[transform,background-color] duration-150 shadow-md"
          >
            Ingresar a la Consulta
          </button>
        </div>
      </div>
    </div>
  );
};

export default PreJoinModal;
