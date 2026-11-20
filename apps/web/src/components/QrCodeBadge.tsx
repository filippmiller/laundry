import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrCodeBadge({ value, label = "QR-код заказа", size = 128 }: { value: string; label?: string; size?: number }) {
  const [src, setSrc] = useState<string>("");

  useEffect(() => {
    if (!value) {
      setSrc("");
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(value, { width: size * 2, margin: 1, color: { dark: "#141920", light: "#ffffff" } })
      .then(url => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc("");
      });
    return () => { cancelled = true; };
  }, [value, size]);

  if (!src) {
    return (
      <div style={{ inlineSize: size, blockSize: size, display: "grid", placeItems: "center", background: "#fff", border: "1px solid var(--border-hairline)", borderRadius: 8 }}>
        <span className="muted mono">QR</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={label}
      width={size}
      height={size}
      style={{ display: "block", borderRadius: 8, border: "1px solid var(--border-hairline)", background: "#fff" }}
    />
  );
}
