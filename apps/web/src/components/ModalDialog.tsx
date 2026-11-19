import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./ui/IconButton";

type ModalDialogProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Native top-layer modal dialog following Chrome Modern Web Guidance:
 * relies on browser showModal() inertness, Esc dismissal, focus restoration,
 * and overscroll containment without redundant ARIA roles.
 */
export function ModalDialog({ open, title, onClose, children }: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      dialog.returnValue = "";
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleClose = () => {
      dialog.returnValue = "";
      onClose();
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  return (
    <dialog ref={ref} className="modal-dialog" aria-labelledby={titleId}>
      <div className="dialog-head">
        <h2 id={titleId} className="panel-title">{title}</h2>
        <IconButton
          label="Закрыть окно"
          icon={<X size={18} aria-hidden="true" />}
          variant="ghost"
          size="sm"
          className="no-print"
          onClick={onClose}
        />
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
