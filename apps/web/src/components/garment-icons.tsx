import type { ReactNode } from "react";
import type { GarmentIconKey } from "@shared/garment-taxonomy";

/**
 * A hand-drawn line-art icon set for the garment picker.
 *
 * Why not `lucide-react`: it has no clothing glyphs — the closest things are
 * generic "shirt" or "package" shapes that do not tell a courier whether the
 * item is a t-shirt or a bra. Why not emoji: DESIGN.md forbids them in the
 * product UI, and they render differently on every platform, which is exactly
 * the kind of inconsistency a handover screen must not have.
 *
 * All icons share one 24×24 grid, one stroke weight and one line cap, so the
 * grid of tiles reads as a single family.
 */
const ICONS: Record<GarmentIconKey, ReactNode> = {
  tshirt: (
    <>
      <path d="M9 3 4.6 5.4 3 9.4 6.4 10.9 7.4 8.6V21h9.2V8.6l1 2.3L21 9.4l-1.6-4L15 3c-.4 1.9-1.7 3-3 3s-2.6-1.1-3-3Z" />
    </>
  ),
  shirt: (
    <>
      <path d="M9 3 4.6 5.4 3 9.4 6.4 10.9 7.4 8.6V21h9.2V8.6l1 2.3L21 9.4l-1.6-4L15 3l-3 2.6L9 3Z" />
      <path d="M12 5.6V21" />
      <path d="M10.2 9.4h.01M10.2 13.4h.01M10.2 17.4h.01" />
    </>
  ),
  dress: (
    <>
      <path d="M9.2 3 12 6.6 14.8 3l2 2.2-1.1 5.3L20 21H4l4.3-10.5L7.2 5.2 9.2 3Z" />
      <path d="M9.6 10.5h4.8" />
    </>
  ),
  coat: (
    <>
      <path d="M9 3 4.4 5.8 3.4 12l3 1.2L7.2 10V21h9.6V10l.8 3.2 3-1.2-1-6.2L15 3l-3 2.8L9 3Z" />
      <path d="M12 5.8V21" />
      <path d="M9.6 6.6 12 10.4l2.4-3.8" />
    </>
  ),
  jacket: (
    <>
      <path d="M8.8 3.4 4.6 5.8 3.4 11.4l2.9 1.3L7.2 9.6V18h9.6V9.6l.9 3.1 2.9-1.3-1.2-5.6-4.2-2.4L12 6.4l-3.2-3Z" />
      <path d="M12 6.4V18" />
      <path d="M8.6 13.6h2.2M13.2 13.6h2.2" />
    </>
  ),
  hoodie: (
    <>
      <path d="M8.6 5.4A3.6 3.6 0 0 1 15.4 5.4" />
      <path d="M8.6 5.4 4.4 7.6 3 12.4l3 1.2L7.2 10V21h9.6V10l1.2 3.6 3-1.2-1.4-4.8-4.2-2.2" />
      <path d="M9.2 15.6h5.6" />
    </>
  ),
  trousers: (
    <>
      <path d="M6.8 3h10.4l.6 18h-4.6L12 10.6 10.8 21H6.2L6.8 3Z" />
      <path d="M6.8 6.4h10.4" />
    </>
  ),
  shorts: (
    <>
      <path d="M6.8 3h10.4l.6 11.4h-4.4L12 9.4l-1.4 5H6.2L6.8 3Z" />
      <path d="M6.8 6.4h10.4" />
    </>
  ),
  skirt: (
    <>
      <path d="M9 3h6l4 16H5L9 3Z" />
      <path d="M9 3 12 8l3-5" />
    </>
  ),
  underwear: (
    <>
      <path d="M4 6h16l-2 7c-.8 3-2 6-4 6h-4c-2 0-3.2-3-4-6L4 6Z" />
      <path d="M4 9.4h16" />
    </>
  ),
  set: (
    <>
      <path d="M8.4 3h7.2l1.2 5H7.2L8.4 3Z" />
      <path d="M4.4 10h15.2l-1.8 6.4c-.7 2.8-1.8 4.6-3.6 4.6h-4.4c-1.8 0-2.9-1.8-3.6-4.6L4.4 10Z" />
      <path d="M4.4 13.2h15.2" />
    </>
  ),
  bra: (
    <>
      <path d="M4.6 11.4h14.8" />
      <path d="M5 11.4c0 5 4.2 6.2 7 3.4v-3.4" />
      <path d="M19 11.4c0 5-4.2 6.2-7 3.4v-3.4" />
      <path d="M6.6 11.4 8.2 5.8M17.4 11.4 15.8 5.8" />
    </>
  ),
  nightgown: (
    <>
      <path d="M9.8 4v3.4M14.2 4v3.4" />
      <path d="M8.6 7.4h6.8l1.4 13.6H7.2L8.6 7.4Z" />
      <path d="M8.6 7.4 12 10.6l3.4-3.2" />
    </>
  ),
  thermal: (
    <>
      <path d="M9 3 5.4 4.8 4.2 12.4 7 13.4 8 10.6V21h8v-10.4l1 2.8 2.8-1-1.2-7.6L15 3l-3 2.6L9 3Z" />
      <path d="M12 5.6V21" />
    </>
  ),
  socks: (
    <>
      <path d="M8 3h4v8.4l4 5c1.5 2.4-.4 4.6-2.8 4.6H9.6c-2 0-3.4-1.6-2.8-3.6L8 3Z" />
      <path d="M8 6.4h4" />
    </>
  ),
  towel: (
    <>
      <path d="M4 6.4h16v13H4z" />
      <path d="M4 9.6h16" />
      <path d="M6.4 13.4c1.2-1.6 2.4-1.6 3.6 0s2.4 1.6 3.6 0 2.4-1.6 3.6 0" />
    </>
  ),
  bedsheet: (
    <>
      <path d="M3 6.6h18v13H3z" />
      <path d="M3 6.6 17 6.6l4 4" />
      <path d="M5.4 10.4h7v5.4h-7z" />
    </>
  ),
  robe: (
    <>
      <path d="M8 3.4h8l3 17.6H5L8 3.4Z" />
      <path d="M8 3.4 12 8.8l4-5.4" />
      <path d="M6.2 13.4h11.6" />
    </>
  ),
  shoes: (
    <>
      <path d="M2.6 17.4h18.8" />
      <path d="M4.2 17.4v-5.2l3-3.2 3.2 3.8 5-0.8 2.6 1.6c1.6 1 2.2 2.6 2.2 3.8" />
      <path d="M7.2 12.2 9.4 14M10.4 12.8l2 1.8" />
    </>
  ),
  belt: (
    <>
      <path d="M2.6 9.6h18.8v4.8H2.6z" />
      <path d="M9.4 8.4v7.2M14.6 8.4v7.2" />
      <path d="M9.4 12h5.2" />
    </>
  ),
  bag: (
    <>
      <path d="M4.8 8h14.4l1.2 12H3.6L4.8 8Z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </>
  ),
};

export type GarmentIconProps = {
  icon: GarmentIconKey;
  size?: number;
  className?: string;
};

/** One garment glyph. Decorative by default — the label next to it carries the meaning. */
export function GarmentIcon({ icon, size = 26, className }: GarmentIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {ICONS[icon]}
    </svg>
  );
}
