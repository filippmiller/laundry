import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import {
  Banknote,
  CheckCircle2,
  EyeOff,
  FileText,
  Lock,
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
  RotateCcw,
  Scale,
  Search,
  Send,
  ShieldAlert,
  Star,
  ThumbsUp,
} from "lucide-react";
import { api, dt, money } from "../api";
import { ModalDialog } from "../components/ModalDialog";
import { CLAIM_STATE_LABELS, ORDER_STATE_LABELS, formatError } from "../labels";

type NotifyFn = (n: { kind: "ok" | "error"; text: string } | null) => void;

type SupportOrder = {
  id: string;
  publicNumber: string;
  lifecycleState: string;
  createdAt: string;
  customerPhone?: string;
  customerName?: string;
  totalKopeks?: number;
};

type SupportThread = {
  id: string;
  orderId?: string | null;
  orderPublicNumber?: string | null;
  publicNumber?: string | null;
  channel?: string;
  subject?: string | null;
  status: string;
  createdAt: string;
  updatedAt?: string;
};

type SupportMessage = {
  id: string;
  senderType?: string;
  authorRole?: string;
  senderRole?: string;
  direction?: string;
  body?: string;
  text?: string;
  message?: string;
  createdAt: string;
};

type ThreadDetail = {
  thread: SupportThread;
  messages: SupportMessage[];
};

type ClaimSummary = {
  id: string;
  orderId: string;
  orderPublicNumber?: string | null;
  publicNumber?: string | null;
  state?: string;
  status?: string;
  claimType?: string;
  reason?: string;
  summary?: string;
  claimedAmountKopeks?: number;
  compensationKopeks?: number;
  createdAt: string;
};

type ClaimItem = {
  id: string;
  orderItemId?: string;
  title?: string;
  description?: string;
  name?: string;
  quantity?: number;
  claimedAmountKopeks?: number;
  amountKopeks?: number;
};

type ClaimDecision = {
  id: string;
  outcome: string;
  rationale?: string;
  reason?: string;
  compensationKopeks?: number;
  decidedByRole?: string;
  actorRole?: string;
  createdAt?: string;
  decidedAt?: string;
};

type EvidenceHold = {
  id: string;
  evidenceAssetId?: string;
  assetId?: string;
  objectKey?: string;
  reason?: string;
  active?: boolean;
  releasedAt?: string | null;
  createdAt?: string;
};

type EvidenceAsset = {
  id: string;
  objectKey: string;
  sha256?: string;
  sha256Hex?: string;
  contentHash?: string;
  digest?: string;
  purpose?: string;
  legalHold?: boolean;
  legal_hold?: boolean;
  holdActive?: boolean;
  createdAt?: string;
};

type ClaimDetail = {
  claim: ClaimSummary;
  items: ClaimItem[];
  decisions: ClaimDecision[];
  evidenceHolds: EvidenceHold[];
};

type ReviewItem = {
  id: string;
  orderId?: string;
  orderPublicNumber?: string | null;
  rating: number;
  body: string;
  likeCount: number;
  status?: string;
  hiddenAt?: string | null;
  hideReason?: string | null;
  createdAt: string;
};

function unwrapList<T>(payload: unknown, keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

function getClaimStatus(claim: ClaimSummary): string {
  return claim.status ?? claim.state ?? "opened";
}

function getHashPrefix(asset: EvidenceAsset): string {
  const full = asset.sha256 ?? asset.sha256Hex ?? asset.contentHash ?? asset.digest;
  if (!full) return "—";
  return full.length > 16 ? `${full.slice(0, 16)}...` : full;
}

function isAssetOnLegalHold(asset: EvidenceAsset, holds: EvidenceHold[]): boolean {
  if (asset.legalHold || asset.legal_hold || asset.holdActive) return true;
  return holds.some(
    (h) =>
      !h.releasedAt &&
      h.active !== false &&
      (h.evidenceAssetId === asset.id ||
        h.assetId === asset.id ||
        (h.objectKey && h.objectKey === asset.objectKey)),
  );
}

function isCustomerMessage(msg: SupportMessage): boolean {
  const role = (msg.senderType ?? msg.authorRole ?? msg.senderRole ?? "").toLowerCase();
  if (role === "customer" || role === "client") return true;
  if (msg.direction?.toLowerCase() === "inbound") return true;
  return false;
}

const CHANNEL_LABELS: Record<string, string> = {
  call: "Звонок",
  phone: "Звонок",
  chat: "Чат",
};

const THREAD_STATUS_LABELS: Record<string, string> = {
  open: "Открыто",
  pending: "В работе",
  closed: "Закрыто",
};

export function SupportClaimsWorkspace({ notify, roles }: { notify: NotifyFn; roles: string[] }) {
  const searchInputId = useId();
  const ticketChannelId = useId();
  const ticketSubjectId = useId();
  const ticketBodyId = useId();
  const replyBodyId = useId();
  const compRubId = useId();
  const decisionOutcomeId = useId();
  const decisionRationaleId = useId();
  const reopenReasonId = useId();
  const hideReviewReasonId = useId();
  const closeReasonId = useId();

  // 1. Order search & quick ticket modal
  const [orderQuery, setOrderQuery] = useState("");
  const [searchingOrders, setSearchingOrders] = useState(false);
  const [hasSearchedOrders, setHasSearchedOrders] = useState(false);
  const [foundOrders, setFoundOrders] = useState<SupportOrder[]>([]);

  const [ticketOrder, setTicketOrder] = useState<SupportOrder | null>(null);
  const [ticketChannel, setTicketChannel] = useState<"call" | "chat">("call");
  const [ticketSubject, setTicketSubject] = useState("");
  const [ticketBody, setTicketBody] = useState("");
  const [creatingTicket, setCreatingTicket] = useState(false);

  // 2. Support threads
  const [threads, setThreads] = useState<SupportThread[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [loadingThreadDetail, setLoadingThreadDetail] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [closingThread, setClosingThread] = useState(false);
  const [closeReason, setCloseReason] = useState("");

  // 3. Claims & legal hold evidence
  const [claims, setClaims] = useState<ClaimSummary[]>([]);
  const [loadingClaims, setLoadingClaims] = useState(false);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [claimDetail, setClaimDetail] = useState<ClaimDetail | null>(null);
  const [orderEvidence, setOrderEvidence] = useState<EvidenceAsset[]>([]);
  const [loadingClaimDetail, setLoadingClaimDetail] = useState(false);

  const [compModalOpen, setCompModalOpen] = useState(false);
  const [compRub, setCompRub] = useState("");
  const [submittingComp, setSubmittingComp] = useState(false);

  const [decisionModalOpen, setDecisionModalOpen] = useState(false);
  const [decisionOutcome, setDecisionOutcome] = useState<"resolved" | "denied_with_reason">("resolved");
  const [decisionRationale, setDecisionRationale] = useState("");
  const [submittingDecision, setSubmittingDecision] = useState(false);

  const [reopenModalOpen, setReopenModalOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [submittingReopen, setSubmittingReopen] = useState(false);

  // 4. Reviews moderation
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [hideReviewTarget, setHideReviewTarget] = useState<ReviewItem | null>(null);
  const [hideReason, setHideReason] = useState("");
  const [submittingHide, setSubmittingHide] = useState(false);

  const loadThreads = useCallback(async () => {
    setLoadingThreads(true);
    try {
      const res = await api<unknown>("/support/threads");
      setThreads(unwrapList<SupportThread>(res, ["threads", "items", "data"]));
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setLoadingThreads(false);
    }
  }, [notify]);

  const loadThreadDetail = useCallback(
    async (threadId: string) => {
      setSelectedThreadId(threadId);
      setLoadingThreadDetail(true);
      try {
        const res = await api<Record<string, unknown>>(`/support/threads/${threadId}`);
        const thread = (res.thread as SupportThread | undefined) ?? (res as unknown as SupportThread);
        const messages = unwrapList<SupportMessage>(res.messages ?? res, ["messages", "items"]);
        setThreadDetail({ thread, messages });
      } catch (err) {
        notify({ kind: "error", text: formatError(err) });
      } finally {
        setLoadingThreadDetail(false);
      }
    },
    [notify],
  );

  const loadClaims = useCallback(async () => {
    setLoadingClaims(true);
    try {
      const res = await api<unknown>("/claims");
      setClaims(unwrapList<ClaimSummary>(res, ["claims", "items", "data"]));
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setLoadingClaims(false);
    }
  }, [notify]);

  const loadClaimAndEvidence = useCallback(
    async (claimId: string, knownOrderId?: string) => {
      setSelectedClaimId(claimId);
      setLoadingClaimDetail(true);
      try {
        const claimPromise = api<Record<string, unknown>>(`/claims/${claimId}`);
        const evidencePromise = knownOrderId
          ? api<unknown>(`/evidence/order/${knownOrderId}`)
          : Promise.resolve(null);

        const [claimRes, preloadedEvidenceRes] = await Promise.all([claimPromise, evidencePromise]);

        const claimObj = (claimRes.claim as ClaimSummary | undefined) ?? (claimRes as unknown as ClaimSummary);
        const items = unwrapList<ClaimItem>(claimRes.items, ["items"]);
        const decisions = unwrapList<ClaimDecision>(claimRes.decisions, ["decisions"]);
        const evidenceHolds = unwrapList<EvidenceHold>(claimRes.evidenceHolds, ["evidenceHolds"]);

        setClaimDetail({
          claim: claimObj,
          items,
          decisions,
          evidenceHolds,
        });

        let evidenceRes = preloadedEvidenceRes;
        if (!evidenceRes && claimObj?.orderId) {
          evidenceRes = await api<unknown>(`/evidence/order/${claimObj.orderId}`);
        }
        setOrderEvidence(unwrapList<EvidenceAsset>(evidenceRes, ["assets", "evidence", "items"]));
      } catch (err) {
        notify({ kind: "error", text: formatError(err) });
      } finally {
        setLoadingClaimDetail(false);
      }
    },
    [notify],
  );

  const loadReviews = useCallback(async () => {
    setLoadingReviews(true);
    try {
      const res = await api<unknown>("/reviews");
      setReviews(unwrapList<ReviewItem>(res, ["reviews", "items", "data"]));
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setLoadingReviews(false);
    }
  }, [notify]);

  useEffect(() => {
    void loadThreads();
    void loadClaims();
    void loadReviews();
  }, [loadThreads, loadClaims, loadReviews]);

  async function handleOrderSearch(e: FormEvent) {
    e.preventDefault();
    const trimmed = orderQuery.trim();
    if (!trimmed) {
      notify({ kind: "error", text: "Введите номер заказа (LA-...) или телефон (+7...)" });
      return;
    }
    setSearchingOrders(true);
    setHasSearchedOrders(true);
    try {
      const res = await api<unknown>(`/support/orders?query=${encodeURIComponent(trimmed)}`);
      setFoundOrders(unwrapList<SupportOrder>(res, ["orders", "items", "data"]));
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setSearchingOrders(false);
    }
  }

  function openTicketModal(order: SupportOrder) {
    setTicketOrder(order);
    setTicketChannel("call");
    setTicketSubject(`Обращение по заказу ${order.publicNumber}`);
    setTicketBody("");
  }

  async function handleCreateTicket(e: FormEvent) {
    e.preventDefault();
    if (!ticketOrder) return;
    const subject = ticketSubject.trim();
    const body = ticketBody.trim();
    if (!subject) {
      notify({ kind: "error", text: "Укажите тему обращения" });
      return;
    }
    if (!body) {
      notify({ kind: "error", text: "Введите текст обращения" });
      return;
    }
    setCreatingTicket(true);
    try {
      const res = await api<Record<string, unknown>>("/support/threads", {
        method: "POST",
        body: {
          orderId: ticketOrder.id,
          channel: ticketChannel,
          subject,
          body,
        },
      });
      const createdThread = (res.thread as SupportThread | undefined) ?? (res as unknown as SupportThread);
      setTicketOrder(null);
      setTicketSubject("");
      setTicketBody("");
      notify({ kind: "ok", text: `Обращение по заказу ${ticketOrder.publicNumber} зарегистрировано` });
      await loadThreads();
      if (createdThread?.id) {
        await loadThreadDetail(createdThread.id);
      }
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setCreatingTicket(false);
    }
  }

  async function handleSendReply(e: FormEvent) {
    e.preventDefault();
    if (!selectedThreadId) return;
    const trimmed = replyText.trim();
    if (!trimmed) {
      notify({ kind: "error", text: "Введите текст ответа" });
      return;
    }
    setSendingReply(true);
    try {
      await api(`/support/threads/${selectedThreadId}/messages`, {
        method: "POST",
        body: { body: trimmed },
      });
      setReplyText("");
      notify({ kind: "ok", text: "Сообщение отправлено клиенту" });
      await Promise.all([loadThreadDetail(selectedThreadId), loadThreads()]);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setSendingReply(false);
    }
  }

  async function handleCloseThread() {
    if (!selectedThreadId) return;
    // The route requires a reason of at least three characters: an empty body was rejected with
    // 400, so the "Закрыть обращение" button never worked.
    const reason = closeReason.trim();
    if (reason.length < 3) {
      notify({ kind: "error", text: "Укажите причину закрытия обращения" });
      return;
    }
    setClosingThread(true);
    try {
      await api(`/support/threads/${selectedThreadId}/close`, {
        method: "POST",
        body: { reason },
      });
      notify({ kind: "ok", text: "Обращение закрыто" });
      setCloseReason("");
      await Promise.all([loadThreadDetail(selectedThreadId), loadThreads()]);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setClosingThread(false);
    }
  }

  async function handleProposeCompensation(e: FormEvent) {
    e.preventDefault();
    if (!selectedClaimId || !claimDetail) return;
    const parsed = Number(compRub.replace(",", "."));
    const amountKopeks = Math.round(parsed * 100);
    if (!Number.isFinite(parsed) || amountKopeks <= 0) {
      notify({ kind: "error", text: "Введите корректную сумму компенсации в рублях" });
      return;
    }
    setSubmittingComp(true);
    try {
      await api(`/claims/${selectedClaimId}/compensations`, {
        method: "POST",
        body: { amountKopeks },
      });
      setCompModalOpen(false);
      setCompRub("");
      notify({ kind: "ok", text: `Компенсация ${money(amountKopeks)} предложена` });
      await Promise.all([
        loadClaims(),
        loadClaimAndEvidence(selectedClaimId, claimDetail.claim.orderId),
      ]);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setSubmittingComp(false);
    }
  }

  async function handleSubmitDecision(e: FormEvent) {
    e.preventDefault();
    if (!selectedClaimId || !claimDetail) return;
    const rationale = decisionRationale.trim();
    if (rationale.length < 10) {
      notify({ kind: "error", text: "Обоснование решения должно содержать минимум 10 символов" });
      return;
    }
    setSubmittingDecision(true);
    try {
      await api(`/claims/${selectedClaimId}/decision`, {
        method: "POST",
        body: {
          outcome: decisionOutcome,
          rationale,
        },
      });
      setDecisionModalOpen(false);
      setDecisionRationale("");
      notify({ kind: "ok", text: "Решение по претензии вынесено" });
      await Promise.all([
        loadClaims(),
        loadClaimAndEvidence(selectedClaimId, claimDetail.claim.orderId),
      ]);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setSubmittingDecision(false);
    }
  }

  async function handleReopenClaim(e: FormEvent) {
    e.preventDefault();
    if (!selectedClaimId || !claimDetail) return;
    const reason = reopenReason.trim();
    if (reason.length < 5) {
      notify({ kind: "error", text: "Причина переоткрытия должна содержать минимум 5 символов" });
      return;
    }
    setSubmittingReopen(true);
    try {
      await api(`/claims/${selectedClaimId}/reopen`, {
        method: "POST",
        body: { reason },
      });
      setReopenModalOpen(false);
      setReopenReason("");
      notify({ kind: "ok", text: "Претензия переоткрыта" });
      await Promise.all([
        loadClaims(),
        loadClaimAndEvidence(selectedClaimId, claimDetail.claim.orderId),
      ]);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setSubmittingReopen(false);
    }
  }

  async function handleHideReview(e: FormEvent) {
    e.preventDefault();
    if (!hideReviewTarget) return;
    const reason = hideReason.trim();
    if (reason.length < 5) {
      notify({ kind: "error", text: "Причина скрытия должна содержать минимум 5 символов" });
      return;
    }
    setSubmittingHide(true);
    try {
      await api(`/reviews/${hideReviewTarget.id}/hide`, {
        method: "POST",
        body: { reason },
      });
      setHideReviewTarget(null);
      setHideReason("");
      notify({ kind: "ok", text: "Отзыв скрыт" });
      await loadReviews();
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setSubmittingHide(false);
    }
  }

  const activeClaimStatus = claimDetail ? getClaimStatus(claimDetail.claim) : "";
  const canReopenClaim =
    activeClaimStatus === "resolved" || activeClaimStatus === "denied_with_reason";
  // Deciding a claim is reserved for the approver role. Offering the button to a plain support
  // agent only produced a 403 from the service.
  const canDecideClaims = roles.includes("claims_approver") || roles.includes("platform_admin");
  const compPreviewKopeks = Math.round(Number(compRub.replace(",", ".")) * 100);

  return (
    <div className="stack" style={{ display: "grid", gap: "1rem" }}>
      {/* 1. Поиск заказа и регистрация обращения */}
      <section className="panel">
        <div className="row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: 0 }}>
            <Search size={18} aria-hidden="true" />
            <span>Поиск заказа и регистрация обращения</span>
          </h2>
        </div>

        <form onSubmit={handleOrderSearch} style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "0.75rem" }}>
          <div className="field" style={{ flex: "1 1 280px", display: "grid", gap: "0.35rem" }}>
            <label htmlFor={searchInputId}>Номер заказа (LA-...) или телефон (+7...)</label>
            <input
              id={searchInputId}
              type="text"
              value={orderQuery}
              onChange={(e) => setOrderQuery(e.target.value)}
              placeholder="Например: LA-2026-0001 или +79990001122"
            />
          </div>
          <button type="submit" className="primary" disabled={searchingOrders} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
            <Search size={16} aria-hidden="true" />
            <span>{searchingOrders ? "Поиск..." : "Найти заказ"}</span>
          </button>
        </form>

        {hasSearchedOrders && (
          <div style={{ marginTop: "1rem" }}>
            {foundOrders.length === 0 ? (
              <p className="muted">Заказы по вашему запросу не найдены.</p>
            ) : (
              <ul className="list" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
                {foundOrders.map((order) => (
                  <li
                    key={order.id}
                    className="list-item"
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "0.75rem",
                      padding: "0.75rem",
                      border: "1px solid var(--border, #e2e8f0)",
                      borderRadius: "0.5rem",
                    }}
                  >
                    <div style={{ display: "grid", gap: "0.2rem" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                        <strong>{order.publicNumber}</strong>
                        <span className="badge">
                          {ORDER_STATE_LABELS[order.lifecycleState] ?? order.lifecycleState}
                        </span>
                      </div>
                      <div className="muted" style={{ fontSize: "0.875rem" }}>
                        Создан: {dt(order.createdAt)}
                        {order.customerPhone ? ` · ${order.customerPhone}` : ""}
                        {order.totalKopeks !== undefined ? ` · ${money(order.totalKopeks)}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => openTicketModal(order)}
                      style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
                    >
                      <MessageSquarePlus size={16} aria-hidden="true" />
                      <span>Открыть тикет по заказу</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {/* 2. Обращения клиентов */}
      <section className="panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: 0 }}>
            <MessageSquare size={18} aria-hidden="true" />
            <span>Обращения клиентов</span>
          </h2>
          <button
            type="button"
            className="ghost"
            onClick={() => void loadThreads()}
            disabled={loadingThreads}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            <span>{loadingThreads ? "Обновление..." : "Обновить"}</span>
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "1rem", alignItems: "start" }}>
          <div>
            {threads.length === 0 ? (
              <p className="muted">Обращений пока нет.</p>
            ) : (
              <ul className="list" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
                {threads.map((t) => {
                  const isSelected = t.id === selectedThreadId;
                  const orderRef = t.orderPublicNumber ?? t.publicNumber;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        className={isSelected ? "primary" : "ghost"}
                        onClick={() => void loadThreadDetail(t.id)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          display: "grid",
                          gap: "0.25rem",
                          padding: "0.75rem",
                          border: "1px solid var(--border, #e2e8f0)",
                          borderRadius: "0.5rem",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                          <strong>{t.subject || (orderRef ? `Заказ ${orderRef}` : `Тикет #${t.id.slice(0, 8)}`)}</strong>
                          <span className="badge">{THREAD_STATUS_LABELS[t.status] ?? t.status}</span>
                        </div>
                        <div style={{ fontSize: "0.85rem", opacity: 0.85 }}>
                          {orderRef ? `Заказ ${orderRef} · ` : ""}
                          {t.channel ? `${CHANNEL_LABELS[t.channel] ?? t.channel} · ` : ""}
                          {dt(t.createdAt)}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div
            style={{
              border: "1px solid var(--border, #e2e8f0)",
              borderRadius: "0.5rem",
              padding: "0.9rem",
              minHeight: "220px",
              display: "grid",
              gap: "0.75rem",
            }}
          >
            {loadingThreadDetail ? (
              <p className="muted">Загрузка переписки...</p>
            ) : !threadDetail ? (
              <p className="muted">Выберите обращение слева, чтобы просмотреть переписку и ответить клиенту.</p>
            ) : (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: "1rem" }}>
                      {threadDetail.thread.subject || `Обращение #${threadDetail.thread.id.slice(0, 8)}`}
                    </h3>
                    <div className="muted" style={{ fontSize: "0.85rem" }}>
                      Статус: {THREAD_STATUS_LABELS[threadDetail.thread.status] ?? threadDetail.thread.status}
                      {threadDetail.thread.orderPublicNumber
                        ? ` · Заказ ${threadDetail.thread.orderPublicNumber}`
                        : ""}
                    </div>
                  </div>
                  {threadDetail.thread.status !== "closed" && (
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <input
                        id={closeReasonId}
                        className="input"
                        value={closeReason}
                        onChange={event => setCloseReason(event.target.value)}
                        placeholder="Причина закрытия"
                        aria-label="Причина закрытия обращения"
                        style={{ minWidth: "14rem" }}
                      />
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void handleCloseThread()}
                        disabled={closingThread}
                        style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
                      >
                        <CheckCircle2 size={16} aria-hidden="true" />
                        <span>{closingThread ? "Закрытие..." : "Закрыть обращение"}</span>
                      </button>
                    </div>
                  )}
                </div>

                <div style={{ display: "grid", gap: "0.5rem", maxHeight: "320px", overflowY: "auto", paddingRight: "0.25rem" }}>
                  {threadDetail.messages.length === 0 ? (
                    <p className="muted">Сообщений в обращении пока нет.</p>
                  ) : (
                    threadDetail.messages.map((m) => {
                      const fromCustomer = isCustomerMessage(m);
                      return (
                        <div
                          key={m.id}
                          style={{
                            padding: "0.6rem 0.75rem",
                            borderRadius: "0.5rem",
                            border: "1px solid var(--border, #e2e8f0)",
                            background: fromCustomer ? "var(--surface-alt, #f8fafc)" : "var(--surface, #ffffff)",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "0.25rem" }}>
                            <strong>{fromCustomer ? "клиент" : "вы"}</strong>
                            <span className="muted">{dt(m.createdAt)}</span>
                          </div>
                          <div style={{ whiteSpace: "pre-wrap" }}>{m.body ?? m.text ?? m.message ?? ""}</div>
                        </div>
                      );
                    })
                  )}
                </div>

                {threadDetail.thread.status !== "closed" ? (
                  <form onSubmit={handleSendReply} style={{ display: "grid", gap: "0.5rem" }}>
                    <div className="field" style={{ display: "grid", gap: "0.35rem" }}>
                      <label htmlFor={replyBodyId}>Ответ клиенту</label>
                      <textarea
                        id={replyBodyId}
                        rows={3}
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder="Введите сообщение для клиента..."
                      />
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <button
                        type="submit"
                        className="primary"
                        disabled={sendingReply}
                        style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
                      >
                        <Send size={15} aria-hidden="true" />
                        <span>{sendingReply ? "Отправка..." : "Отправить"}</span>
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="muted" style={{ margin: 0 }}>
                    Обращение закрыто. Отправка новых сообщений недоступна.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </section>

      {/* 3. Претензии и удержание доказательств (Legal Hold) */}
      <section className="panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: 0 }}>
            <ShieldAlert size={18} aria-hidden="true" />
            <span>Претензии и удержание доказательств (Legal Hold)</span>
          </h2>
          <button
            type="button"
            className="ghost"
            onClick={() => void loadClaims()}
            disabled={loadingClaims}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            <span>{loadingClaims ? "Обновление..." : "Обновить"}</span>
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "1rem", alignItems: "start" }}>
          <div>
            {claims.length === 0 ? (
              <p className="muted">Претензий нет.</p>
            ) : (
              <ul className="list" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
                {claims.map((c) => {
                  const status = getClaimStatus(c);
                  const isSelected = c.id === selectedClaimId;
                  const orderRef = c.orderPublicNumber ?? c.publicNumber ?? c.orderId;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={isSelected ? "primary" : "ghost"}
                        onClick={() => void loadClaimAndEvidence(c.id, c.orderId)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          display: "grid",
                          gap: "0.25rem",
                          padding: "0.75rem",
                          border: "1px solid var(--border, #e2e8f0)",
                          borderRadius: "0.5rem",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                          <strong>Заказ {orderRef}</strong>
                          <span className="badge">{CLAIM_STATE_LABELS[status] ?? status}</span>
                        </div>
                        <div style={{ fontSize: "0.85rem", opacity: 0.85 }}>
                          {c.reason ?? c.summary ?? c.claimType ?? "Претензия"} · {dt(c.createdAt)}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div
            style={{
              border: "1px solid var(--border, #e2e8f0)",
              borderRadius: "0.5rem",
              padding: "0.9rem",
              minHeight: "260px",
              display: "grid",
              gap: "0.9rem",
            }}
          >
            {loadingClaimDetail ? (
              <p className="muted">Загрузка претензии и защищённых доказательств...</p>
            ) : !claimDetail ? (
              <p className="muted">
                Выберите претензию слева. При открытии автоматически загружаются доказательства заказа с записью в журнал аудита.
              </p>
            ) : (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: "0.75rem" }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: "1rem" }}>
                      Претензия #{claimDetail.claim.id.slice(0, 8)} · Заказ{" "}
                      {claimDetail.claim.orderPublicNumber ?? claimDetail.claim.publicNumber ?? claimDetail.claim.orderId}
                    </h3>
                    <div className="muted" style={{ fontSize: "0.875rem", marginTop: "0.2rem" }}>
                      Статус: <strong>{CLAIM_STATE_LABELS[activeClaimStatus] ?? activeClaimStatus}</strong>
                      {" · "}Создана: {dt(claimDetail.claim.createdAt)}
                      {claimDetail.claim.claimedAmountKopeks !== undefined
                        ? ` · Заявлено: ${money(claimDetail.claim.claimedAmountKopeks)}`
                        : ""}
                      {claimDetail.claim.compensationKopeks !== undefined && claimDetail.claim.compensationKopeks > 0
                        ? ` · Компенсация: ${money(claimDetail.claim.compensationKopeks)}`
                        : ""}
                    </div>
                    {(claimDetail.claim.reason || claimDetail.claim.summary) && (
                      <p style={{ margin: "0.4rem 0 0" }}>
                        {claimDetail.claim.reason ?? claimDetail.claim.summary}
                      </p>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setCompRub("");
                      setCompModalOpen(true);
                    }}
                    style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
                  >
                    <Banknote size={16} aria-hidden="true" />
                    <span>Предложить компенсацию</span>
                  </button>

                  {canDecideClaims && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        setDecisionOutcome("resolved");
                        setDecisionRationale("");
                        setDecisionModalOpen(true);
                      }}
                      style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
                    >
                      <Scale size={16} aria-hidden="true" />
                      <span>Вынести решение</span>
                    </button>
                  )}

                  {canReopenClaim && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setReopenReason("");
                        setReopenModalOpen(true);
                      }}
                      style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
                    >
                      <RotateCcw size={16} aria-hidden="true" />
                      <span>Переоткрыть претензию</span>
                    </button>
                  )}
                </div>

                {claimDetail.items.length > 0 && (
                  <div style={{ display: "grid", gap: "0.4rem" }}>
                    <h4 style={{ margin: 0, fontSize: "0.95rem" }}>Позиции претензии</h4>
                    <ul className="list" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.35rem" }}>
                      {claimDetail.items.map((item) => (
                        <li
                          key={item.id}
                          style={{
                            padding: "0.5rem 0.65rem",
                            border: "1px solid var(--border, #e2e8f0)",
                            borderRadius: "0.4rem",
                            fontSize: "0.9rem",
                          }}
                        >
                          <strong>{item.title ?? item.name ?? item.description ?? `Позиция #${item.id.slice(0, 6)}`}</strong>
                          {item.description && item.title ? ` — ${item.description}` : ""}
                          {(item.claimedAmountKopeks ?? item.amountKopeks) !== undefined
                            ? ` · ${money((item.claimedAmountKopeks ?? item.amountKopeks) as number)}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div style={{ display: "grid", gap: "0.4rem" }}>
                  <h4 style={{ margin: 0, fontSize: "0.95rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <Lock size={15} aria-hidden="true" />
                    <span>Доказательства и удержание (Legal Hold)</span>
                  </h4>
                  <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                    Доступ к доказательствам заказа зафиксирован в журнале аудита. Активных удержаний: {claimDetail.evidenceHolds.filter((h) => !h.releasedAt && h.active !== false).length}.
                  </p>
                  {orderEvidence.length === 0 && claimDetail.evidenceHolds.length === 0 ? (
                    <p className="muted" style={{ margin: 0 }}>Связанные доказательства отсутствуют.</p>
                  ) : orderEvidence.length > 0 ? (
                    <ul className="list" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.4rem" }}>
                      {orderEvidence.map((asset) => {
                        const held = isAssetOnLegalHold(asset, claimDetail.evidenceHolds);
                        return (
                          <li
                            key={asset.id}
                            style={{
                              padding: "0.55rem 0.7rem",
                              border: "1px solid var(--border, #e2e8f0)",
                              borderRadius: "0.4rem",
                              display: "grid",
                              gap: "0.2rem",
                              fontSize: "0.875rem",
                            }}
                          >
                            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0.4rem" }}>
                              <code style={{ wordBreak: "break-all" }}>{asset.objectKey}</code>
                              {held && <span className="badge">legal_hold</span>}
                            </div>
                            <div className="muted">
                              SHA-256: <code>{getHashPrefix(asset)}</code>
                              {asset.purpose ? ` · Назначение: ${asset.purpose}` : ""}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <ul className="list" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.4rem" }}>
                      {claimDetail.evidenceHolds.map((hold) => (
                        <li
                          key={hold.id}
                          style={{
                            padding: "0.55rem 0.7rem",
                            border: "1px solid var(--border, #e2e8f0)",
                            borderRadius: "0.4rem",
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: "0.5rem",
                            fontSize: "0.875rem",
                          }}
                        >
                          <div>
                            <code>{hold.objectKey ?? hold.evidenceAssetId ?? hold.assetId ?? hold.id}</code>
                            {hold.reason ? <div className="muted">{hold.reason}</div> : null}
                          </div>
                          {!hold.releasedAt && hold.active !== false && (
                            <span className="badge">legal_hold</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div style={{ display: "grid", gap: "0.4rem" }}>
                  <h4 style={{ margin: 0, fontSize: "0.95rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <FileText size={15} aria-hidden="true" />
                    <span>История решений</span>
                  </h4>
                  {claimDetail.decisions.length === 0 ? (
                    <p className="muted" style={{ margin: 0 }}>Решения по претензии ещё не выносились.</p>
                  ) : (
                    <ul className="list" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.4rem" }}>
                      {claimDetail.decisions.map((d) => (
                        <li
                          key={d.id}
                          style={{
                            padding: "0.55rem 0.7rem",
                            border: "1px solid var(--border, #e2e8f0)",
                            borderRadius: "0.4rem",
                            display: "grid",
                            gap: "0.2rem",
                            fontSize: "0.875rem",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                            <strong>{CLAIM_STATE_LABELS[d.outcome] ?? d.outcome}</strong>
                            <span className="muted">{dt(d.decidedAt ?? d.createdAt)}</span>
                          </div>
                          {(d.rationale ?? d.reason) && <div>{d.rationale ?? d.reason}</div>}
                          {d.compensationKopeks !== undefined && d.compensationKopeks > 0 && (
                            <div className="muted">Компенсация: {money(d.compensationKopeks)}</div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      {/* 4. Модерация отзывов */}
      <section className="panel">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", marginBottom: "0.75rem" }}>
          <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem", margin: 0 }}>
            <Star size={18} aria-hidden="true" />
            <span>Модерация отзывов</span>
          </h2>
          <button
            type="button"
            className="ghost"
            onClick={() => void loadReviews()}
            disabled={loadingReviews}
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            <span>{loadingReviews ? "Обновление..." : "Обновить"}</span>
          </button>
        </div>

        {reviews.length === 0 ? (
          <p className="muted">Опубликованных отзывов пока нет.</p>
        ) : (
          <ul className="list" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.6rem" }}>
            {reviews.map((review) => {
              const isHidden = review.status === "hidden" || Boolean(review.hiddenAt);
              return (
                <li
                  key={review.id}
                  style={{
                    padding: "0.75rem",
                    border: "1px solid var(--border, #e2e8f0)",
                    borderRadius: "0.5rem",
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: "0.75rem",
                  }}
                >
                  <div style={{ display: "grid", gap: "0.35rem", flex: "1 1 320px" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.6rem" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", fontWeight: 600 }}>
                        <Star size={15} aria-hidden="true" />
                        <span>{review.rating} / 5</span>
                      </span>
                      <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", fontSize: "0.875rem" }}>
                        <ThumbsUp size={14} aria-hidden="true" />
                        <span>{review.likeCount}</span>
                      </span>
                      <span className="muted" style={{ fontSize: "0.875rem" }}>
                        {dt(review.createdAt)}
                      </span>
                      {isHidden && <span className="badge">Скрыт</span>}
                    </div>
                    <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{review.body}</p>
                    {review.hideReason && (
                      <div className="muted" style={{ fontSize: "0.85rem" }}>
                        Причина скрытия: {review.hideReason}
                      </div>
                    )}
                  </div>

                  {!isHidden && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setHideReviewTarget(review);
                        setHideReason("");
                      }}
                      style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}
                    >
                      <EyeOff size={15} aria-hidden="true" />
                      <span>Скрыть с причиной</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Modal: Открыть тикет по заказу */}
      <ModalDialog
        open={ticketOrder !== null}
        title={ticketOrder ? `Открыть тикет по заказу ${ticketOrder.publicNumber}` : "Открыть тикет по заказу"}
        onClose={() => setTicketOrder(null)}
      >
        <form onSubmit={handleCreateTicket} style={{ display: "grid", gap: "0.75rem" }}>
          <div className="field" style={{ display: "grid", gap: "0.35rem" }}>
            <label htmlFor={ticketChannelId}>Канал обращения</label>
            <select
              id={ticketChannelId}
              value={ticketChannel}
              onChange={(e) => setTicketChannel(e.target.value as "call" | "chat")}
            >
              <option value="call">Звонок</option>
              <option value="chat">Чат</option>
            </select>
          </div>

          <div className="field" style={{ display: "grid", gap: "0.35rem" }}>
            <label htmlFor={ticketSubjectId}>Тема обращения</label>
            <input
              id={ticketSubjectId}
              type="text"
              value={ticketSubject}
              onChange={(e) => setTicketSubject(e.target.value)}
              placeholder="Краткая тема обращения"
            />
          </div>

          <div className="field" style={{ display: "grid", gap: "0.35rem" }}>
            <label htmlFor={ticketBodyId}>Описание обращения</label>
            <textarea
              id={ticketBodyId}
              rows={4}
              value={ticketBody}
              onChange={(e) => setTicketBody(e.target.value)}
              placeholder="Суть звонка или сообщения клиента..."
            />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button type="button" className="ghost" onClick={() => setTicketOrder(null)}>
              Отмена
            </button>
            <button type="submit" className="primary" disabled={creatingTicket}>
              {creatingTicket ? "Создание..." : "Создать обращение"}
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal: Предложить компенсацию */}
      <ModalDialog
        open={compModalOpen}
        title="Предложить компенсацию"
        onClose={() => setCompModalOpen(false)}
      >
        <form onSubmit={handleProposeCompensation} style={{ display: "grid", gap: "0.75rem" }}>
          <div className="field" style={{ display: "grid", gap: "0.35rem" }}>
            <label htmlFor={compRubId}>Сумма компенсации (руб.)</label>
            <input
              id={compRubId}
              type="number"
              min="1"
              step="0.01"
              value={compRub}
              onChange={(e) => setCompRub(e.target.value)}
              placeholder="Например: 500"
            />
            {Number.isFinite(compPreviewKopeks) && compPreviewKopeks > 0 && (
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                К начислению: {money(compPreviewKopeks)} ({compPreviewKopeks} коп.)
              </span>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button type="button" className="ghost" onClick={() => setCompModalOpen(false)}>
              Отмена
            </button>
            <button type="submit" className="primary" disabled={submittingComp}>
              {submittingComp ? "Отправка..." : "Предложить компенсацию"}
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal: Вынести решение */}
      <ModalDialog
        open={decisionModalOpen}
        title="Вынести решение по претензии"
        onClose={() => setDecisionModalOpen(false)}
      >
        <form onSubmit={handleSubmitDecision} style={{ display: "grid", gap: "0.75rem" }}>
          <div className="field" style={{ display: "grid", gap: "0.35rem" }}>
            <label htmlFor={decisionOutcomeId}>Итог рассмотрения</label>
            <select
              id={decisionOutcomeId}
              value={decisionOutcome}
              onChange={(e) => setDecisionOutcome(e.target.value as "resolved" | "denied_with_reason")}
            >
              <option value="resolved">Удовлетворить претензию (resolved)</option>
              <option value="denied_with_reason">Отклонить с обоснованием (denied_with_reason)</option>
            </select>
          </div>

          <div className="field" style={{ display: "grid", gap: "0.35rem" }}>
            <label htmlFor={decisionRationaleId}>Обоснование решения (минимум 10 символов)</label>
            <textarea
              id={decisionRationaleId}
              rows={4}
              value={decisionRationale}
              onChange={(e) => setDecisionRationale(e.target.value)}
              placeholder="Укажите подробное обоснование на основе проверенных доказательств..."
            />
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              Символов: {decisionRationale.trim().length} / 10 минимум
            </span>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button type="button" className="ghost" onClick={() => setDecisionModalOpen(false)}>
              Отмена
            </button>
            <button
              type="submit"
              className="primary"
              disabled={submittingDecision || decisionRationale.trim().length < 10}
            >
              {submittingDecision ? "Сохранение..." : "Вынести решение"}
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal: Переоткрыть претензию */}
      <ModalDialog
        open={reopenModalOpen}
        title="Переоткрыть претензию"
        onClose={() => setReopenModalOpen(false)}
      >
        <form onSubmit={handleReopenClaim} style={{ display: "grid", gap: "0.75rem" }}>
          <div className="field" style={{ display: "grid", gap: "0.35rem" }}>
            <label htmlFor={reopenReasonId}>Причина переоткрытия (минимум 5 символов)</label>
            <textarea
              id={reopenReasonId}
              rows={3}
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="Опишите основание для пересмотра претензии..."
            />
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              Символов: {reopenReason.trim().length} / 5 минимум
            </span>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button type="button" className="ghost" onClick={() => setReopenModalOpen(false)}>
              Отмена
            </button>
            <button
              type="submit"
              className="primary"
              disabled={submittingReopen || reopenReason.trim().length < 5}
            >
              {submittingReopen ? "Обработка..." : "Переоткрыть претензию"}
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal: Скрыть отзыв с причиной */}
      <ModalDialog
        open={hideReviewTarget !== null}
        title="Скрыть отзыв с причиной"
        onClose={() => setHideReviewTarget(null)}
      >
        <form onSubmit={handleHideReview} style={{ display: "grid", gap: "0.75rem" }}>
          {hideReviewTarget && (
            <p className="muted" style={{ margin: 0, fontSize: "0.875rem" }}>
              Отзыв с оценкой {hideReviewTarget.rating}/5 от {dt(hideReviewTarget.createdAt)}
            </p>
          )}
          <div className="field" style={{ display: "grid", gap: "0.35rem" }}>
            <label htmlFor={hideReviewReasonId}>Причина скрытия (минимум 5 символов)</label>
            <textarea
              id={hideReviewReasonId}
              rows={3}
              value={hideReason}
              onChange={(e) => setHideReason(e.target.value)}
              placeholder="Укажите причину модерации отзыва..."
            />
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              Символов: {hideReason.trim().length} / 5 минимум
            </span>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button type="button" className="ghost" onClick={() => setHideReviewTarget(null)}>
              Отмена
            </button>
            <button
              type="submit"
              className="primary"
              disabled={submittingHide || hideReason.trim().length < 5}
            >
              {submittingHide ? "Сохранение..." : "Скрыть отзыв"}
            </button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
