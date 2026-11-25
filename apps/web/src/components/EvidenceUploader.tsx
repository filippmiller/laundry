import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Camera, FileCheck2, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { ApiError, api, dt, sha256FileHex } from "../api";
import { EVIDENCE_PURPOSE_LABELS, formatError, stateLabel } from "../labels";
import { Badge, type BadgeTone, Button, Card, CardBody, CardHeader } from "./ui";
import {
  cancelEvidenceUploadBatches,
  clearEvidenceUploadError,
  evidenceOwnerKey,
  finishEvidenceUploadBatch,
  getOwnerUploadSnapshot,
  setEvidenceUploadError,
  startEvidenceUploadBatch,
  subscribeEvidenceUploads,
} from "./evidence-upload-store";
import {
  enqueueEvidence,
  evidenceQueueAvailable,
  markEvidenceAttempt,
  queuedEvidence,
  removeQueuedEvidence,
  type QueuedEvidence,
} from "./evidence-offline-queue";

export type EvidenceOwnerType = "order" | "claim" | "custody_event";
export type EvidencePurpose = "intake_condition" | "delivery_proof" | "claim_evidence" | "qc";

export type EvidenceUploadState = {
  ownerId: string;
  uploadedIds: string[];
  uploadingCount: number;
  hasError: boolean;
};

export type EvidenceUploaderProps = {
  ownerType: EvidenceOwnerType;
  ownerId: string;
  purpose: EvidencePurpose;
  title?: string;
  refreshKey?: number;
  notify: (n: { kind: "ok" | "error"; text: string } | null) => void;
  onUploadedIdsChange?: (ids: string[]) => void;
  onUploadStateChange?: (state: EvidenceUploadState) => void;
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

/**
 * Did the request fail because the network is gone (rather than because the server said no)?
 * Only this kind of failure may send the file to the local queue; a rejected file has to be
 * reported as an error.
 */
function isNetworkFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch() rejects with TypeError on a network error.
  if (err instanceof DOMException && err.name === "NetworkError") return true;
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  return message.includes("network") || message.includes("failed to fetch") || message.includes("offline");
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
  refreshKey = 0,
  notify,
  onUploadedIdsChange,
  onUploadStateChange,
}: EvidenceUploaderProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const onUploadedIdsChangeRef = useRef(onUploadedIdsChange);
  const onUploadStateChangeRef = useRef(onUploadStateChange);

  const currentOwnerKey = evidenceOwnerKey(ownerType, ownerId);
  const activeOwnerRef = useRef({ ownerType, ownerId, ownerKey: currentOwnerKey });
  const requestGenRef = useRef(0);

  const [assetsState, setAssetsState] = useState<{ ownerKey: string; items: EvidenceAssetItem[] }>({
    ownerKey: currentOwnerKey,
    items: [],
  });
  const [loadingState, setLoadingState] = useState<{ ownerKey: string; active: boolean }>({
    ownerKey: currentOwnerKey,
    active: false,
  });
  const [uploadSnapshot, setUploadSnapshot] = useState(() => getOwnerUploadSnapshot(currentOwnerKey));
  const lastCompletionVersionRef = useRef(uploadSnapshot.completionVersion);
  const [deletingState, setDeletingState] = useState<{ ownerKey: string; id: string | null }>({
    ownerKey: currentOwnerKey,
    id: null,
  });
  const [loadErrorState, setLoadErrorState] = useState<{
    ownerKey: string;
    loadError: string | null;
  }>({
    ownerKey: currentOwnerKey,
    loadError: null,
  });
  // Photos that waited for the network on this device.
  const [queuedCount, setQueuedCount] = useState(0);

  useEffect(() => {
    const initial = getOwnerUploadSnapshot(currentOwnerKey);
    lastCompletionVersionRef.current = initial.completionVersion;
    setUploadSnapshot(initial);
    return subscribeEvidenceUploads(() => {
      setUploadSnapshot(getOwnerUploadSnapshot(currentOwnerKey));
    });
  }, [currentOwnerKey]);

  const assets = assetsState.ownerKey === currentOwnerKey ? assetsState.items : [];
  const loading = loadingState.ownerKey === currentOwnerKey ? loadingState.active : false;
  const uploadingCount = uploadSnapshot.ownerKey === currentOwnerKey ? uploadSnapshot.uploadingCount : 0;
  const uploading = uploadingCount > 0;
  const deletingId = deletingState.ownerKey === currentOwnerKey ? deletingState.id : null;
  const loadError = loadErrorState.ownerKey === currentOwnerKey ? loadErrorState.loadError : null;
  const uploadError = uploadSnapshot.ownerKey === currentOwnerKey ? uploadSnapshot.lastError : null;
  const hasError = Boolean(loadError || uploadError);

  useEffect(() => {
    onUploadedIdsChangeRef.current = onUploadedIdsChange;
  }, [onUploadedIdsChange]);

  useEffect(() => {
    onUploadStateChangeRef.current = onUploadStateChange;
  }, [onUploadStateChange]);

  const verifiedIds = useMemo(
    () => assets.filter(a => a.status === "verified").map(a => a.id),
    [assets],
  );

  useEffect(() => {
    onUploadedIdsChangeRef.current?.(verifiedIds);
  }, [ownerId, verifiedIds]);

  useEffect(() => {
    onUploadStateChangeRef.current?.({
      ownerId,
      uploadedIds: verifiedIds,
      uploadingCount,
      hasError,
    });
  }, [ownerId, verifiedIds, uploadingCount, hasError]);

  const loadAssets = useCallback(
    async (options?: { reportErrorToast?: boolean }) => {
      const targetOwnerKey = evidenceOwnerKey(ownerType, ownerId);
      const gen = ++requestGenRef.current;
      if (!ownerId) {
        setAssetsState({ ownerKey: targetOwnerKey, items: [] });
        setLoadErrorState({ ownerKey: targetOwnerKey, loadError: null });
        setLoadingState({ ownerKey: targetOwnerKey, active: false });
        return;
      }
      setLoadingState({ ownerKey: targetOwnerKey, active: true });
      setLoadErrorState({ ownerKey: targetOwnerKey, loadError: null });
      try {
        const res = await api<unknown>(`/evidence/${ownerType}/${ownerId}`);
        if (requestGenRef.current !== gen || activeOwnerRef.current.ownerKey !== targetOwnerKey) {
          return;
        }
        setAssetsState({ ownerKey: targetOwnerKey, items: normalizeEvidenceList(res) });
      } catch (err) {
        if (requestGenRef.current !== gen || activeOwnerRef.current.ownerKey !== targetOwnerKey) {
          return;
        }
        const message = formatError(err);
        setLoadErrorState({ ownerKey: targetOwnerKey, loadError: message });
        if (options?.reportErrorToast || !(err instanceof ApiError && err.status === 403)) {
          notify({ kind: "error", text: message });
        }
      } finally {
        if (requestGenRef.current === gen && activeOwnerRef.current.ownerKey === targetOwnerKey) {
          setLoadingState({ ownerKey: targetOwnerKey, active: false });
        }
      }
    },
    [ownerType, ownerId, notify],
  );

  useEffect(() => {
    activeOwnerRef.current = { ownerType, ownerId, ownerKey: currentOwnerKey };
    requestGenRef.current += 1;
    setAssetsState({ ownerKey: currentOwnerKey, items: [] });
    setLoadErrorState({ ownerKey: currentOwnerKey, loadError: null });
    setDeletingState({ ownerKey: currentOwnerKey, id: null });
    setLoadingState({ ownerKey: currentOwnerKey, active: false });
  }, [ownerType, ownerId, currentOwnerKey]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets, refreshKey]);

  // When a background upload batch finishes for this owner (including after A -> B -> A remount),
  // automatically re-fetch assets so uploadedIds / onUploadStateChange reflect the newly verified files.
  useEffect(() => {
    if (
      currentOwnerKey
      && uploadSnapshot.ownerKey === currentOwnerKey
      && uploadSnapshot.completionVersion > lastCompletionVersionRef.current
    ) {
      lastCompletionVersionRef.current = uploadSnapshot.completionVersion;
      void loadAssets();
    }
  }, [currentOwnerKey, uploadSnapshot.ownerKey, uploadSnapshot.completionVersion, loadAssets]);

  const handleCancelUploads = () => {
    if (!currentOwnerKey) return;
    const cancelledCount = cancelEvidenceUploadBatches(currentOwnerKey);
    if (cancelledCount > 0) {
      notify({ kind: "error", text: "Загрузка файлов отменена." });
    }
  };

  /**
   * Registers the file on the server and uploads its bytes. The SHA-256 is computed from the
   * bytes themselves, so a queued photo is hashed the same way when it is finally sent.
   */
  const uploadEvidenceFile = async (
    file: Blob,
    fileName: string,
    mimeType: string,
    sizeBytes: number,
    targetOwnerType: EvidenceOwnerType,
    targetOwnerId: string,
    signal?: AbortSignal,
  ) => {
    const sha256 = await sha256FileHex(file as File);
    const objectKey = buildObjectKey(targetOwnerType, targetOwnerId, fileName);
    const regRes = await api<{ evidenceId?: string; id?: string; status?: string }>("/evidence", {
      method: "POST",
      signal,
      body: {
        ownerType: targetOwnerType,
        ownerId: targetOwnerId,
        objectKey,
        sha256,
        purpose,
        mimeType,
        sizeBytes,
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
      signal,
      body: { contentBase64, mimeType },
    });
    return evidenceId;
  };

  /** Puts files into the on-device queue; returns how many were accepted. */
  const queueFiles = async (
    files: File[],
    targetOwnerType: EvidenceOwnerType,
    targetOwnerId: string,
  ): Promise<number> => {
    if (!evidenceQueueAvailable()) return 0;
    let queued = 0;
    for (const file of files) {
      if (!ALLOWED_MIME_SET.has(file.type)) continue;
      if (file.size <= 0 || file.size > MAX_EVIDENCE_BYTES) continue;
      try {
        await enqueueEvidence({
          ownerType: targetOwnerType,
          ownerId: targetOwnerId,
          purpose,
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          blob: file,
        });
        queued += 1;
      } catch {
        // A browser that refuses IndexedDB cannot queue: the file is simply lost, and the
        // upload error below tells the truth about it.
      }
    }
    return queued;
  };

  const refreshQueuedCount = useCallback(async () => {
    if (!evidenceQueueAvailable() || !ownerType || !ownerId) {
      setQueuedCount(0);
      return;
    }
    try {
      const rows = await queuedEvidence(ownerType, ownerId);
      setQueuedCount(rows.length);
    } catch {
      setQueuedCount(0);
    }
  }, [ownerType, ownerId]);

  /** Sends everything that waited in the queue as soon as the network is back. */
  const flushQueuedEvidence = useCallback(async () => {
    if (!evidenceQueueAvailable() || !ownerType || !ownerId) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let rows: QueuedEvidence[] = [];
    try {
      rows = await queuedEvidence(ownerType, ownerId);
    } catch {
      return;
    }
    if (!rows.length) {
      setQueuedCount(0);
      return;
    }
    const uploaded: string[] = [];
    for (const row of rows) {
      try {
        await uploadEvidenceFile(
          row.blob,
          row.fileName,
          row.mimeType,
          row.sizeBytes,
          row.ownerType as EvidenceOwnerType,
          row.ownerId,
        );
        uploaded.push(row.id);
      } catch (err) {
        await markEvidenceAttempt(row.id, formatError(err)).catch(() => undefined);
        // The connection is still broken: the rest of the queue waits for the next attempt.
        break;
      }
    }
    if (uploaded.length) {
      await removeQueuedEvidence(uploaded).catch(() => undefined);
      await refreshQueuedCount();
      await loadAssets({ reportErrorToast: true }).catch(() => undefined);
      notify({
        kind: "ok",
        text: `Отправлено файлов из очереди: ${uploaded.length}.`,
      });
    }
  }, [ownerType, ownerId, refreshQueuedCount, loadAssets, notify]);

  useEffect(() => {
    void refreshQueuedCount();
  }, [refreshQueuedCount]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => void flushQueuedEvidence();
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [flushQueuedEvidence]);

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

    const targetOwnerType = ownerType;
    const targetOwnerId = ownerId;
    const targetOwnerKey = evidenceOwnerKey(targetOwnerType, targetOwnerId);
    const isSameOwner = () => activeOwnerRef.current.ownerKey === targetOwnerKey;

    // No network in the stairwell: the photo is kept on the device and uploaded when the
    // connection returns, instead of being lost with the page.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const queued = await queueFiles(files, targetOwnerType, targetOwnerId);
      if (queued > 0) {
        notify({
          kind: "ok",
          text: `Сети нет: файлов сохранено в очереди — ${queued}. Они уйдут автоматически, когда связь появится.`,
        });
        await refreshQueuedCount();
      }
      return;
    }

    const { generation, abortController } = startEvidenceUploadBatch(targetOwnerKey, files.length);
    const isCancelled = () => abortController.signal.aborted;
    let uploadedCount = 0;

    try {
      for (const file of files) {
        if (isCancelled()) return;
        if (!ALLOWED_MIME_SET.has(file.type)) {
          const msg = `Файл «${file.name}»: неподдерживаемый формат. Допустимы JPEG, PNG, WebP и PDF.`;
          setEvidenceUploadError(targetOwnerKey, msg);
          if (isSameOwner()) notify({ kind: "error", text: msg });
          continue;
        }
        if (file.size <= 0) {
          const msg = `Файл «${file.name}» пустой и не может быть загружен.`;
          setEvidenceUploadError(targetOwnerKey, msg);
          if (isSameOwner()) notify({ kind: "error", text: msg });
          continue;
        }
        if (file.size > MAX_EVIDENCE_BYTES) {
          const msg = `Файл «${file.name}» превышает максимальный размер 15 МБ.`;
          setEvidenceUploadError(targetOwnerKey, msg);
          if (isSameOwner()) notify({ kind: "error", text: msg });
          continue;
        }

        try {
          await uploadEvidenceFile(
            file,
            file.name,
            file.type,
            file.size,
            targetOwnerType,
            targetOwnerId,
            abortController.signal,
          );
        } catch (err) {
          if (isCancelled() || (err instanceof DOMException && err.name === "AbortError")) return;
          // A network failure must not throw the photo away: it goes to the local queue.
          if (isNetworkFailure(err)) {
            const queued = await queueFiles([file], targetOwnerType, targetOwnerId);
            if (queued > 0) {
              await refreshQueuedCount();
              if (isSameOwner()) {
                notify({
                  kind: "ok",
                  text: "Связь пропала: файл сохранён на устройстве и уйдёт автоматически.",
                });
              }
              continue;
            }
          }
          throw err;
        }
        if (isCancelled()) return;

        uploadedCount += 1;
      }

      if (uploadedCount > 0 && isSameOwner()) {
        await loadAssets({ reportErrorToast: true });
        if (!isSameOwner()) return;
        notify({
          kind: "ok",
          text:
            uploadedCount === 1
              ? "Файл доказательства загружен и проверен по SHA-256."
              : `Загружено и проверено файлов: ${uploadedCount}.`,
        });
      }
    } catch (err) {
      if (isCancelled() || (err instanceof DOMException && err.name === "AbortError")) {
        return;
      }
      const msg = formatError(err);
      setEvidenceUploadError(targetOwnerKey, msg);
      if (isSameOwner()) {
        await loadAssets().catch(() => {});
        if (isSameOwner()) {
          notify({ kind: "error", text: msg });
        }
      }
    } finally {
      finishEvidenceUploadBatch(targetOwnerKey, generation);
    }
  };

  const handleDelete = async (asset: EvidenceAssetItem) => {
    const targetOwnerKey = currentOwnerKey;
    const isSameOwner = () => activeOwnerRef.current.ownerKey === targetOwnerKey;
    setDeletingState({ ownerKey: targetOwnerKey, id: asset.id });
    try {
      await api(`/evidence/${asset.id}`, {
        method: "DELETE",
      });
      if (!isSameOwner()) return;
      setAssetsState(prev =>
        prev.ownerKey === targetOwnerKey
          ? { ownerKey: targetOwnerKey, items: prev.items.filter(item => item.id !== asset.id) }
          : prev,
      );
      notify({ kind: "ok", text: `Доказательство #${asset.id.slice(0, 8)} удалено.` });
    } catch (err) {
      if (isSameOwner()) {
        notify({ kind: "error", text: formatError(err) });
      }
    } finally {
      if (isSameOwner()) {
        setDeletingState({ ownerKey: targetOwnerKey, id: null });
      }
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
        subtitle={`Допустимы JPEG, PNG, WebP, PDF до 15 МБ · Проверено: ${verifiedCount}${
          queuedCount > 0 ? ` · в очереди без сети: ${queuedCount}` : ""
        }`}
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
            <input
              ref={cameraInputRef}
              id={`${inputId}-camera`}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              disabled={uploading || !ownerId}
              onChange={e => void handleFilesSelected(e)}
              style={{ display: "none" }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leadingIcon={<Camera size={15} aria-hidden="true" />}
              disabled={!ownerId}
              onClick={() => cameraInputRef.current?.click()}
            >
              Снять фото
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leadingIcon={<Upload size={15} aria-hidden="true" />}
              disabled={!ownerId}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? `Загрузка (${uploadingCount})...` : "Загрузить фото / PDF"}
            </Button>
            {queuedCount > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                leadingIcon={<RefreshCw size={15} aria-hidden="true" />}
                onClick={() => void flushQueuedEvidence()}
              >
                Отправить очередь ({queuedCount})
              </Button>
            )}
            {uploading && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                leadingIcon={<X size={15} aria-hidden="true" />}
                onClick={handleCancelUploads}
              >
                Отменить загрузку
              </Button>
            )}
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
        {uploadError && (
          <div className="alert-banner" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{uploadError}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => clearEvidenceUploadError(currentOwnerKey)}
            >
              Скрыть
            </Button>
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

                  <div className="button-row">
                    {(asset.status === "verified" || asset.status === "legal_hold" || asset.status === "retained") && (
                      <a
                        className="ghost btn--sm"
                        href={`/api/v1/evidence/${asset.id}/content`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Открыть
                      </a>
                    )}
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
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
