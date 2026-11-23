import { useEffect, useState } from "react";
import { Printer, FileText } from "lucide-react";
import { api, dt, money } from "../api";
import { ModalDialog } from "./ModalDialog";

export type DocumentKind = "customer_invoice" | "intake_receipt" | "partner_act" | "upd_draft";

export type RussianDocumentDto = {
  kind: DocumentKind;
  title: string;
  number: string;
  issuedAt: string;
  legalSeller: string;
  counterparty: string;
  orderPublicNumber?: string;
  lines: Array<{ name: string; qty: number; unit: string; amountKopeks: number }>;
  totalKopeks: number;
  disclaimer: string;
};

type Props = {
  open: boolean;
  kind: DocumentKind;
  id: string | null;
  onClose: () => void;
};

export function DocumentPrintModal({ open, kind, id, onClose }: Props) {
  const [doc, setDoc] = useState<RussianDocumentDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !id) {
      setDoc(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setDoc(null);
    api<RussianDocumentDto>(`/documents/${kind}/${id}`)
      .then(data => { if (!cancelled) setDoc(data); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : "Ошибка загрузки документа"); });
    return () => { cancelled = true; };
  }, [open, kind, id]);

  return (
    <ModalDialog open={open} title={doc?.title ?? "Печатная форма документа"} onClose={onClose}>
      {error && <div className="notice error">{error}</div>}
      {!doc && !error && <p className="muted">Формирование документа...</p>}
      {doc && (
        <div>
          <div className="alert-banner" style={{ marginBlockStart: 0 }}>
            <strong>Важно:</strong> {doc.disclaimer}
          </div>
          <div style={{ border: "1px solid var(--border-strong)", borderRadius: 10, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBlockEnd: 12 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>
                  <FileText size={16} aria-hidden="true" style={{ verticalAlign: "text-bottom", marginInlineEnd: 6 }} />
                  {doc.title.includes(doc.number) ? doc.title : <>{doc.title} № <span className="mono">{doc.number}</span></>}
                </div>
                {doc.orderPublicNumber && (
                  <div className="muted">Заказ: <span className="mono">{doc.orderPublicNumber}</span></div>
                )}
              </div>
              <div className="muted mono">Дата: {dt(doc.issuedAt)}</div>
            </div>
            <div className="grid-two" style={{ marginBlockEnd: 14 }}>
              <div>
                <div className="muted">Исполнитель / Поставщик</div>
                <strong>{doc.legalSeller}</strong>
              </div>
              <div>
                <div className="muted">Контрагент / Получатель</div>
                <strong>{doc.counterparty}</strong>
              </div>
            </div>
            <div className="table-wrap">
              <table className="clean-table">
                <thead>
                  <tr>
                    <th>Позиция / Услуга</th>
                    <th>Кол-во</th>
                    <th>Ед.</th>
                    <th>Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.lines.map((line, i) => (
                    <tr key={i}>
                      <td>{line.name}</td>
                      <td className="mono">{line.qty}</td>
                      <td>{line.unit}</td>
                      <td className="mono">{money(line.amountKopeks)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="line-item total">
              <span>Итого к оплате / учёту</span>
              <span className="mono">{money(doc.totalKopeks)}</span>
            </div>
          </div>
          <div className="button-row no-print">
            <button type="button" className="primary" onClick={() => window.print()}>
              <Printer size={18} aria-hidden="true" />
              <span>Печать / Сохранить PDF</span>
            </button>
          </div>
        </div>
      )}
    </ModalDialog>
  );
}
