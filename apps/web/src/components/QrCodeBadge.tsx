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
      <div
        className="u-grid u-pi-center u-bg-fff u-bd-1px-solid-var-border-hairline u-brr-8px"
        style={{ inlineSize: size, blockSize: size }}
      >
        <span className="muted mono">QR</span>
      </div>
    );
  }

  return (
    <img className="u-block u-brr-8px u-bd-1px-solid-var-border-hairline u-bg-fff"
      src={src}
      alt={label}
      width={size}
      height={size}
    />
  );
}
