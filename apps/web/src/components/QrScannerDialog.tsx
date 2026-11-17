import { useEffect, useId, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { Camera, Keyboard } from "lucide-react";
import { ModalDialog } from "./ModalDialog";

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
        const reader = new BrowserMultiFormatReader();
        controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, result => {
          if (cancelled || !result) return;
          const text = result.getText().trim();
          if (text) {
            controls?.stop();
            setCameraActive(false);
            onDetected(text);
            onClose();
          }
        });
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
      <p className="muted" style={{ marginBlockEnd: 12 }}>
        Наведите камеру на QR-код квитанции, мешка или пломбы либо введите идентификатор вручную.
      </p>

      <div className="button-row" style={{ marginBlockEnd: 14 }}>
        <button
          type="button"
          className="secondary"
          onClick={() => setCameraActive(prev => !prev)}
        >
          <Camera size={18} aria-hidden="true" />
          <span>{cameraActive ? "Остановить камеру" : "Включить камеру (@zxing)"}</span>
        </button>
      </div>

      {cameraActive && (
        <div style={{ marginBlockEnd: 14 }}>
          <video ref={videoRef} className="video-preview" muted playsInline />
        </div>
      )}

      {cameraError && (
        <div className="alert-banner" role="status">{cameraError}</div>
      )}

      <div className="field">
        <label htmlFor={inputId}>
          <Keyboard size={14} aria-hidden="true" style={{ verticalAlign: "text-bottom", marginInlineEnd: 6 }} />
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
