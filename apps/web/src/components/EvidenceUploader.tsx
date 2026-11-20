import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, FileCheck2, RefreshCw, Trash2, Upload } from "lucide-react";
import { ApiError, api, dt, sha256FileHex } from "../api";
import { EVIDENCE_PURPOSE_LABELS, formatError, stateLabel } from "../labels";
import { Badge, type BadgeTone, Button, Card, CardBody, CardHeader } from "./ui";

export type EvidenceOwnerType = "order" | "claim" | "custody_event";
export type EvidencePurpose = "intake_condition" | "delivery_proof" | "claim_evidence" | "qc";

export type EvidenceUploaderProps = {
  ownerType: EvidenceOwnerType;
  ownerId: string;
  purpose: EvidencePurpose;
  title?: string;
  notify: (n: { kind: "ok" | "error"; text: string } | null) => void;
  onUploadedIdsChange?: (ids: string[]) => void;
};

type EvidenceAssetItem = {
  id: string;
  sha256: string;
  purpose: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  createdAt?: string;
};

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

const ALLOWED_MIME_SET = new Set<string>(ALLOWED_MIME_TYPES);
const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;

const EVIDENCE_STATUS_LABELS: Record<string, string> = {
  pending_upload: "Ожидает загрузки",
  verified: "Проверено",
  retained: "Сохранено",
  legal_hold: "Юр. удержание",
  quarantined: "Карантин",
  expired: "Истекло",
};

const EVIDENCE_STATUS_TONES: Record<string, BadgeTone> = {
  pending_upload: "warn",
  verified: "ok",
  retained: "info",
  legal_hold: "warn",
  quarantined: "danger",
  expired: "neutral",
};

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function normalizeEvidenceList(raw: unknown): EvidenceAssetItem[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).assets)
      ? ((raw as Record<string, unknown>).assets as unknown[])
      : [];

  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
    .map(row => ({
      id: String(row.id ?? row.evidenceId ?? ""),
      sha256: String(row.sha256 ?? ""),
      purpose: String(row.purpose ?? "other"),
      mimeType: String(row.mimeType ?? ""),
      sizeBytes: Number(row.sizeBytes ?? 0),
      status: String(row.status ?? "pending_upload"),
      createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
    }))
    .filter(item => item.id.length > 0);
}

function buildObjectKey(ownerType: EvidenceOwnerType, ownerId: string, fileName: string): string {
  const safeName =
    (fileName || "file")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "file";
  return `evidence/${ownerType}/${ownerId}/${Date.now()}-${safeName}`.slice(0, 300);
}

export function EvidenceUploader({
  ownerType,
  ownerId,
  purpose,
  title = "Фото- и документ-доказательства",
  notify,
  onUploadedIdsChange,
}: EvidenceUploaderProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const onUploadedIdsChangeRef = useRef(onUploadedIdsChange);

  const [assets, setAssets] = useState<EvidenceAssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    onUploadedIdsChangeRef.current = onUploadedIdsChange;
  }, [onUploadedIdsChange]);

  useEffect(() => {
    const verifiedIds = assets.filter(a => a.status === "verified").map(a => a.id);
    onUploadedIdsChangeRef.current?.(verifiedIds);
  }, [assets]);

  const loadAssets = useCallback(
    async (options?: { reportErrorToast?: boolean }) => {
      if (!ownerId) {
        setAssets([]);
        setLoadError(null);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const res = await api<unknown>(`/evidence/${ownerType}/${ownerId}`);
        setAssets(normalizeEvidenceList(res));
      } catch (err) {
        const message = formatError(err);
        setLoadError(message);
        if (options?.reportErrorToast || !(err instanceof ApiError && err.status === 403)) {
          notify({ kind: "error", text: message });
        }
      } finally {
        setLoading(false);
      }
    },
    [ownerType, ownerId, notify],
  );

  useEffect(() => {
    setAssets([]);
    void loadAssets();
  }, [loadAssets]);

  const handleFilesSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    event.target.value = "";

    if (!ownerId) {
      notify({ kind: "error", text: "Не выбран объект для привязки доказательства." });
      return;
    }

    if (typeof crypto === "undefined" || !crypto.subtle || typeof crypto.subtle.digest !== "function") {
      notify({
        kind: "error",
        text: "Браузер не поддерживает Web Crypto API (crypto.subtle) для расчёта SHA-256. Откройте приложение по HTTPS или на localhost.",
      });
      return;
    }

    setUploading(true);
    let uploadedCount = 0;

    try {
      for (const file of files) {
        if (!ALLOWED_MIME_SET.has(file.type)) {
          notify({
            kind: "error",
            text: `Файл «${file.name}»: неподдерживаемый формат. Допустимы JPEG, PNG, WebP и PDF.`,
          });
          continue;
        }
        if (file.size <= 0) {
          notify({
            kind: "error",
            text: `Файл «${file.name}» пустой и не может быть загружен.`,
          });
          continue;
        }
        if (file.size > MAX_EVIDENCE_BYTES) {
          notify({
            kind: "error",
            text: `Файл «${file.name}» превышает максимальный размер 15 МБ.`,
          });
          continue;
        }

        const sha256 = await sha256FileHex(file);
        const objectKey = buildObjectKey(ownerType, ownerId, file.name);
        const regRes = await api<{ evidenceId?: string; id?: string; status?: string }>("/evidence", {
          method: "POST",
          body: {
            ownerType,
            ownerId,
            objectKey,
            sha256,
            purpose,
            mimeType: file.type,
            sizeBytes: file.size,
          },
        });

        const evidenceId = regRes.evidenceId ?? regRes.id;
        if (!evidenceId) {
          throw new Error("Сервер не вернул идентификатор зарегистрированного файла.");
        }

        const buffer = await file.arrayBuffer();
        const contentBase64 = arrayBufferToBase64(buffer);

        await api(`/evidence/${evidenceId}/upload`, {
          method: "POST",
          body: {
            contentBase64,
            mimeType: file.type,
          },
        });

        uploadedCount += 1;
      }

      if (uploadedCount > 0) {
        await loadAssets({ reportErrorToast: true });
        notify({
          kind: "ok",
          text:
            uploadedCount === 1
              ? "Файл доказательства загружен и проверен по SHA-256."
              : `Загружено и проверено файлов: ${uploadedCount}.`,
        });
      }
    } catch (err) {
      await loadAssets().catch(() => {});
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (asset: EvidenceAssetItem) => {
    setDeletingId(asset.id);
    try {
      await api(`/evidence/${asset.id}`, {
        method: "DELETE",
      });
      setAssets(prev => prev.filter(item => item.id !== asset.id));
      notify({ kind: "ok", text: `Доказательство #${asset.id.slice(0, 8)} удалено.` });
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setDeletingId(null);
    }
  };

  const verifiedCount = assets.filter(a => a.status === "verified").length;

  return (
    <Card quiet>
      <CardHeader
        title={
          <span className="row row--tight">
            <FileCheck2 size={18} aria-hidden="true" />
            <span>{title}</span>
          </span>
        }
        subtitle={`Допустимы JPEG, PNG, WebP, PDF до 15 МБ · Проверено: ${verifiedCount}`}
        actions={
          <div className="button-row">
            <input
              ref={fileInputRef}
              id={inputId}
              type="file"
              accept={ALLOWED_MIME_TYPES.join(",")}
              multiple
              disabled={uploading || !ownerId}
              onChange={e => void handleFilesSelected(e)}
              style={{ display: "none" }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leadingIcon={<Upload size={15} aria-hidden="true" />}
              disabled={uploading || !ownerId}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? "Загрузка..." : "Загрузить фото / PDF"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              leadingIcon={<RefreshCw size={15} aria-hidden="true" />}
              disabled={loading || uploading || !ownerId}
              onClick={() => void loadAssets({ reportErrorToast: true })}
            >
              Обновить
            </Button>
          </div>
        }
      />
      <CardBody>
        {loadError && (
          <div className="alert-banner" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>Не удалось загрузить список доказательств: {loadError}</span>
          </div>
        )}

        {assets.length === 0 ? (
          <p className="muted">
            {loading ? "Загрузка списка доказательств..." : "Загруженные файлы отсутствуют."}
          </p>
        ) : (
          <ul className="list">
            {assets.map(asset => {
              const isLegalHold = asset.status === "legal_hold";
              const isDeleting = deletingId === asset.id;
              return (
                <li key={asset.id} className="list-item">
                  <div className="stack stack--tight">
                    <div className="row row--tight">
                      <Badge tone="info">
                        {stateLabel(EVIDENCE_PURPOSE_LABELS, asset.purpose)}
                      </Badge>
                      <Badge tone={EVIDENCE_STATUS_TONES[asset.status] ?? "neutral"}>
                        {stateLabel(EVIDENCE_STATUS_LABELS, asset.status)}
                      </Badge>
                      <code>#{asset.id.slice(0, 8)}</code>
                      {asset.sha256 ? (
                        <span className="muted">
                          SHA-256: <code>{asset.sha256.slice(0, 12)}…</code>
                        </span>
                      ) : null}
                    </div>
                    <span className="muted">
                      {asset.mimeType || "Файл"} · {formatFileSize(asset.sizeBytes)}
                      {asset.createdAt ? ` · ${dt(asset.createdAt)}` : ""}
                    </span>
                  </div>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    leadingIcon={<Trash2 size={14} aria-hidden="true" />}
                    disabled={isDeleting || uploading || isLegalHold}
                    title={isLegalHold ? "Удаление запрещено: юридическое удержание" : "Удалить файл"}
                    onClick={() => void handleDelete(asset)}
                  >
                    {isDeleting ? "Удаление..." : "Удалить"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
