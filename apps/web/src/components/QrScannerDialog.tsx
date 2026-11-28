import { useEffect, useId, useRef, useState } from "react";
import { Camera, Keyboard } from "lucide-react";
import { ModalDialog } from "./ModalDialog";

/**
 * The scanner library is heavy — roughly 200 KB of the courier workspace chunk — and a courier who
 * never opens the scanner should never pay for it. It is therefore imported dynamically, at the
 * moment the camera is actually switched on, and the button stays disabled until the module has
 * arrived.
 */
type ZxingReader = {
  decodeFromConstraints: (
    constraints: { video: { facingMode: { ideal: string } } },
    video: HTMLVideoElement,
    callback: (result: { getText: () => string } | undefined) => void,
  ) => Promise<{ stop: () => void }>;
  decodeFromVideoDevice: (
    deviceId: string | undefined,
    video: HTMLVideoElement,
    callback: (result: { getText: () => string } | undefined) => void,
  ) => Promise<{ stop: () => void }>;
};

let zxingModule: Promise<ZxingReader> | null = null;

function loadZxing(): Promise<ZxingReader> {
  if (!zxingModule) {
    zxingModule = import("@zxing/browser").then(mod => ({
      decodeFromConstraints: (
        constraints: { video: { facingMode: { ideal: string } } },
        video: HTMLVideoElement,
        callback: (result: { getText: () => string } | undefined) => void,
      ) => new mod.BrowserMultiFormatReader().decodeFromConstraints(
        constraints as never,
        video,
        callback as never,
      ) as Promise<{ stop: () => void }>,
      decodeFromVideoDevice: (
        deviceId: string | undefined,
        video: HTMLVideoElement,
        callback: (result: { getText: () => string } | undefined) => void,
      ) => new mod.BrowserMultiFormatReader().decodeFromVideoDevice(
        deviceId,
        video,
        callback as never,
      ) as Promise<{ stop: () => void }>,
    }));
  }
  return zxingModule;
}

type QrScannerDialogProps = {
  open: boolean;
  onClose: () => void;
  onDetected: (code: string) => void;
  title?: string;
};

export function QrScannerDialog({
  open,
  onClose,
  onDetected,
  title = "Сканирование QR или штрихкода",
}: QrScannerDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputId = useId();
  const [manual, setManual] = useState("");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);

  useEffect(() => {
    if (!open) {
      setCameraActive(false);
      setCameraError(null);
      setManual("");
    }
  }, [open]);

  useEffect(() => {
    if (!open || !cameraActive) return;
    let cancelled = false;
    let controls: { stop: () => void } | undefined;

    async function start() {
      setCameraError(null);
      if (!videoRef.current || !navigator.mediaDevices?.getUserMedia) {
        setCameraError("Камера недоступна в этом браузере. Используйте ручной ввод ниже.");
        return;
      }
      try {
        const zxing = await loadZxing();
        if (cancelled) return;
        const reader = zxing;
        const handleResult = (result: { getText: () => string } | undefined) => {
          if (cancelled || !result) return;
          const text = result.getText().trim();
          if (text) {
            controls?.stop();
            setCameraActive(false);
            onDetected(text);
            onClose();
          }
        };
        let nextControls: { stop: () => void };
        try {
          nextControls = await reader.decodeFromConstraints(
            { video: { facingMode: { ideal: "environment" } } },
            videoRef.current,
            handleResult,
          );
        } catch {
          if (cancelled || !videoRef.current) return;
          nextControls = await reader.decodeFromVideoDevice(undefined, videoRef.current, handleResult);
        }
        if (cancelled) {
          nextControls.stop();
          return;
        }
        controls = nextControls;
      } catch {
        if (!cancelled) {
          setCameraError("Не удалось получить доступ к камере. Введите код пломбы/заказа вручную.");
          setCameraActive(false);
        }
      }
    }

    void start();
    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, [open, cameraActive, onDetected, onClose]);

  function submitManual() {
    const trimmed = manual.trim();
    if (!trimmed) return;
    setManual("");
    setCameraActive(false);
    onDetected(trimmed);
    onClose();
  }

  return (
    <ModalDialog
      open={open}
      title={title}
      onClose={() => {
        setCameraActive(false);
        onClose();
      }}
    >
      <p className="muted u-mb-12px">
        Наведите камеру на QR-код квитанции, мешка или пломбы либо введите идентификатор вручную.
      </p>

      <div className="button-row u-mb-14px">
        <button
          type="button"
          className="secondary"
          onClick={() => setCameraActive(prev => !prev)}
        >
          <Camera size={18} aria-hidden="true" />
          <span>{cameraActive ? "Остановить камеру" : "Включить камеру"}</span>
        </button>
      </div>

      {cameraActive && (
        <div className="u-mb-14px">
          <video ref={videoRef} className="video-preview" muted playsInline />
        </div>
      )}

      {cameraError && (
        <div className="alert-banner" role="status">{cameraError}</div>
      )}

      <div className="field">
        <label htmlFor={inputId}>
          <Keyboard size={14} aria-hidden="true" className="u-va-text-bottom u-mie-6px" />
          Ручной ввод кода (пломба, мешок или строка LND1:...)
        </label>
        <input
          id={inputId}
          value={manual}
          onChange={e => setManual(e.target.value)}
          placeholder="Например: DEMO-SEAL-001 или BAG-123"
          onKeyDown={e => { if (e.key === "Enter") submitManual(); }}
        />
      </div>

      <div className="button-row">
        <button type="button" className="primary" disabled={!manual.trim()} onClick={submitManual}>
          Применить код
        </button>
      </div>
    </ModalDialog>
  );
}
