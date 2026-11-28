import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Minus, Pencil, Plus, Trash2 } from "lucide-react";
import { ModalDialog } from "./ModalDialog";
import { GarmentIcon } from "./garment-icons";
import {
  GARMENT_CATEGORIES,
  MAX_DECLARED_ROWS,
  MAX_PICKED_QUANTITY,
  findSubtype,
  type GarmentCategory,
  type GarmentIconKey,
  type GarmentSubtype,
} from "@shared/garment-taxonomy";

export type PickedGarment = {
  subtypeId: string;
  category: string;
  label: string;
  quantity: number;
  icon: GarmentIconKey;
};

type GarmentPickerProps = {
  value: PickedGarment[];
  onChange: (next: PickedGarment[]) => void;
  title?: string;
  hint?: string;
  /** When set, the picker is replaced by the reason — e.g. Эконом has no per-item inventory. */
  disabledReason?: string;
  /** Extra controls rendered inside each picked row (declared value, notes…). */
  renderExtra?: (item: PickedGarment) => ReactNode;
};

const QUICK_CHOICES = [1, 2, 3, 5, 10];

function categoryOf(subtypeId: string): GarmentCategory | null {
  for (const category of GARMENT_CATEGORIES) {
    if (category.subtypes.some(subtype => subtype.id === subtypeId)) return category;
  }
  return null;
}

/**
 * The handover picker: an icon grid → subtype overlay → quantity.
 *
 * The whole point is that nobody types anything. The courier stands at the
 * door with a phone in one hand and a bag in the other, so the fastest possible
 * path is "tap the picture of the thing, drag the number". The customer gets
 * the same control on their own phone, and what they declare becomes part of
 * the immutable quote — so the acceptance screen can show "клиент заявил 3
 * футболки" next to "приняли 2 футболки" instead of two contradictory lists.
 */
export function GarmentPicker({
  value,
  onChange,
  title = "Что сдаёте",
  hint,
  disabledReason,
  renderExtra,
}: GarmentPickerProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [category, setCategory] = useState<GarmentCategory | null>(null);
  const [subtype, setSubtype] = useState<GarmentSubtype | null>(null);
  const [quantity, setQuantity] = useState(1);
  const wheelRef = useRef<HTMLDivElement>(null);
  const touchYRef = useRef<number | null>(null);

  const total = useMemo(() => value.reduce((sum, item) => sum + item.quantity, 0), [value]);
  const atRowLimit = value.length >= MAX_DECLARED_ROWS;

  const openCategory = (next: GarmentCategory) => {
    setCategory(next);
    setSubtype(null);
    setQuantity(1);
    setDialogOpen(true);
  };

  const openExisting = (item: PickedGarment) => {
    const found = findSubtype(item.subtypeId);
    if (!found) return;
    setCategory(categoryOf(item.subtypeId));
    setSubtype(found);
    setQuantity(item.quantity);
    setDialogOpen(true);
  };

  const chooseSubtype = (next: GarmentSubtype) => {
    const existing = value.find(item => item.subtypeId === next.id);
    if (!existing && atRowLimit) return;
    setSubtype(next);
    setQuantity(existing?.quantity ?? 1);
  };

  const commit = () => {
    if (!subtype) return;
    const isExisting = value.some(item => item.subtypeId === subtype.id);
    if (!isExisting && atRowLimit) return;
    const next = isExisting
      ? value.map(item => (item.subtypeId === subtype.id
        ? { ...item, quantity: Math.min(MAX_PICKED_QUANTITY, quantity) }
        : item))
      : [...value, {
          subtypeId: subtype.id,
          category: subtype.category,
          label: subtype.label,
          quantity: Math.min(MAX_PICKED_QUANTITY, quantity),
          icon: subtype.icon,
        }];
    onChange(next);
    setDialogOpen(false);
  };

  const remove = (subtypeId: string) => {
    onChange(value.filter(item => item.subtypeId !== subtypeId));
  };

  // The number is also a scroll wheel: swipe up for more, down for less. It is
  // the fastest gesture on a phone that is already in one hand.
  useEffect(() => {
    const node = wheelRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? 1 : -1;
      setQuantity(current => Math.min(MAX_PICKED_QUANTITY, Math.max(1, current + delta)));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [dialogOpen, subtype]);

  if (disabledReason) {
    return (
      <div className="notice" role="note">
        {disabledReason}
      </div>
    );
  }

  return (
    <div className="garment-picker">
      <div className="garment-picker-head">
        <strong className="section-title">{title}</strong>
        {hint ? <span className="muted">{hint}</span> : null}
      </div>

      <div className="garment-grid">
        {GARMENT_CATEGORIES.map(item => (
          <button
            key={item.id}
            type="button"
            className="garment-tile"
            onClick={() => openCategory(item)}
          >
            <span className="garment-tile-icon">
              <GarmentIcon icon={item.icon} size={30} />
            </span>
            <span className="garment-tile-label">{item.label}</span>
          </button>
        ))}
      </div>

      {atRowLimit ? (
        <p className="muted u-mt-8px" role="status">
          Достигнут лимит позиций ({MAX_DECLARED_ROWS}). Удалите или измените существующую позицию.
        </p>
      ) : null}

      {value.length > 0 ? (
        <>
          <p className="muted garment-total">
            Всего вещей: <strong>{total}</strong>
          </p>
          <ul className="garment-picked">
            {value.map(item => (
              <li key={item.subtypeId}>
                <GarmentIcon icon={item.icon} size={22} />
                <span className="garment-picked-label">{item.label}</span>
                {renderExtra ? renderExtra(item) : null}
                <span className="garment-picked-qty">× {item.quantity}</span>
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Изменить количество: ${item.label}`}
                  onClick={() => openExisting(item)}
                >
                  <Pencil size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Убрать: ${item.label}`}
                  onClick={() => remove(item.subtypeId)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <ModalDialog
        open={dialogOpen}
        title={subtype ? subtype.label : (category?.label ?? title)}
        onClose={() => setDialogOpen(false)}
      >
        {subtype ? (
          <div className="garment-qty">
            <div className="garment-qty-head">
              <GarmentIcon icon={subtype.icon} size={30} />
              <strong>{subtype.label}</strong>
            </div>

            <div
              ref={wheelRef}
              className="garment-qty-value"
              aria-live="polite"
              aria-label={`Количество: ${quantity}`}
              onTouchStart={event => {
                touchYRef.current = event.touches[0]?.clientY ?? null;
              }}
              onTouchMove={event => {
                if (touchYRef.current === null) return;
                const currentY = event.touches[0]?.clientY;
                if (currentY === undefined) return;
                const diff = touchYRef.current - currentY;
                if (Math.abs(diff) >= 18) {
                  const step = diff > 0 ? 1 : -1;
                  setQuantity(current => Math.min(MAX_PICKED_QUANTITY, Math.max(1, current + step)));
                  touchYRef.current = currentY;
                }
              }}
              onTouchEnd={() => {
                touchYRef.current = null;
              }}
            >
              {quantity}
            </div>

            <div className="garment-qty-controls">
              <button
                type="button"
                className="secondary"
                aria-label="Уменьшить количество"
                onClick={() => setQuantity(current => Math.max(1, current - 1))}
              >
                <Minus size={20} aria-hidden="true" />
              </button>
              <input
                type="range"
                min={1}
                max={MAX_PICKED_QUANTITY}
                step={1}
                value={quantity}
                aria-label={`Количество: ${subtype.label}`}
                onChange={event => setQuantity(Number(event.target.value))}
              />
              <button
                type="button"
                className="secondary"
                aria-label="Увеличить количество"
                onClick={() => setQuantity(current => Math.min(MAX_PICKED_QUANTITY, current + 1))}
              >
                <Plus size={20} aria-hidden="true" />
              </button>
            </div>

            <div className="garment-qty-chips">
              {QUICK_CHOICES.map(choice => (
                <button
                  key={choice}
                  type="button"
                  className={quantity === choice ? "chip active" : "chip"}
                  onClick={() => setQuantity(choice)}
                >
                  {choice}
                </button>
              ))}
            </div>

            <div className="button-row u-mt-4px">
              <button type="button" className="secondary" onClick={() => setSubtype(null)}>
                <ArrowLeft size={18} aria-hidden="true" />
                <span>Назад</span>
              </button>
              <button type="button" className="primary" onClick={commit}>
                <Check size={18} aria-hidden="true" />
                <span>Готово</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="garment-subtypes">
            {atRowLimit ? (
              <p className="muted u-gc-1-1 u-m-0px" role="status">
                Достигнут лимит позиций ({MAX_DECLARED_ROWS}). Можно изменить только уже добавленные виды.
              </p>
            ) : null}
            {category?.subtypes.map(item => {
              const isExisting = value.some(v => v.subtypeId === item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="garment-subtype"
                  disabled={atRowLimit && !isExisting}
                  onClick={() => chooseSubtype(item)}
                >
                  <GarmentIcon icon={item.icon} size={24} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </ModalDialog>
    </div>
  );
}
