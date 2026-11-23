import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  Eye,
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
import { ApiError, api, dt, money } from "../api";
import { ModalDialog } from "../components/ModalDialog";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Input, Select, Textarea } from "../components/ui/Field";
import { PageHeader } from "../components/ui/PageHeader";
import { Reveal, Stagger } from "../components/ui/Reveal";
import { StatGrid, StatTile } from "../components/ui/StatTile";
import { TabPanel, Tabs } from "../components/ui/Tabs";
import {
  CLAIM_STATE_LABELS,
  CLAIM_TYPE_LABELS,
  EVIDENCE_PURPOSE_LABELS,
  ORDER_STATE_LABELS,
  claimStateTone,
  formatError,
  orderStateTone,
  stateLabel,
} from "../labels";

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
  state?: string;
  status?: string;
  createdAt: string;
  updatedAt?: string;
};

type SupportMessage = {
  id: string;
  isMine?: boolean;
  authorKind?: "customer" | "support";
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
  hasEarlier?: boolean;
  earlierCursor?: string | null;
  totalMessages?: number;
};

type ClaimSummary = {
  id: string;
  orderId: string;
  orderPublicNumber?: string | null;
  publicNumber?: string | null;
  state?: string;
  status?: string;
  claimType?: string;
  description?: string;
  reason?: string;
  summary?: string;
  claimedAmountKopeks?: number;
  compensationKopeks?: number;
  openedAt?: string;
  createdAt?: string;
};

type ClaimItem = {
  id: string;
  orderItemId?: string;
  title?: string;
  description?: string;
  issue?: string;
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
  id?: string;
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
  sha256?: string;
  sha256Hex?: string;
  contentHash?: string;
  digest?: string;
  purpose?: string;
  mimeType?: string;
  sizeBytes?: number;
  status?: string;
  legalHold?: boolean;
  legal_hold?: boolean;
  holdActive?: boolean;
  createdAt?: string;
};

type EvidencePreview = {
  assetId: string;
  label: string;
  mimeType: string;
  blobUrl: string;
};

const SUPPORT_LIST_PAGE_SIZE = 50;

async function fetchPaginatedList<T>(
  path: string,
  keys: string[],
  options: { cursor?: string | null; query?: string } = {},
): Promise<{ items: T[]; totalCount: number; nextCursor: string | null; hasMore: boolean }> {
  const params = new URLSearchParams({ limit: String(SUPPORT_LIST_PAGE_SIZE) });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.query?.trim()) params.set("query", options.query.trim());
  const response = await fetch(`/api/v1${path}?${params.toString()}`, {
    method: "GET",
    credentials: "include",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      payload?.error?.code ?? payload?.error?.message ?? "REQUEST_FAILED",
      response.status,
      payload?.error?.details,
    );
  }
  const items = unwrapList<T>(payload, keys);
  const rawTotal = response.headers.get("X-Total-Count");
  const parsedTotal = rawTotal !== null ? Number(rawTotal) : NaN;
  const totalCount = Number.isFinite(parsedTotal) && parsedTotal >= 0 ? parsedTotal : items.length;
  const nextCursor = response.headers.get("X-Next-Cursor");
  const hasMore = response.headers.get("X-Has-More") === "true" && Boolean(nextCursor);
  return { items, totalCount, nextCursor, hasMore };
}

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
  if (asset.legalHold || asset.legal_hold || asset.holdActive || asset.status === "legal_hold") return true;
  return holds.some(
    (h) =>
      !h.releasedAt &&
      h.active !== false &&
      (h.evidenceAssetId === asset.id || h.assetId === asset.id),
  );
}

function isCustomerMessage(msg: SupportMessage): boolean {
  if (msg.authorKind === "customer") return true;
  if (msg.authorKind === "support") return false;
  if (typeof msg.isMine === "boolean") return !msg.isMine;
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

/**
 * Semantic → badge tone for support threads, per the status table in
 * docs/UI_SYSTEM.md. Order and claim states are mapped by the shared helpers
 * in apps/web/src/labels.ts.
 */
const THREAD_STATUS_TONES: Record<string, BadgeTone> = {
  open: "info",
  pending: "warn",
  closed: "ok",
};

function threadStatusTone(status: string): BadgeTone {
  return THREAD_STATUS_TONES[status] ?? "neutral";
}

export function SupportClaimsWorkspace({ notify, roles }: { notify: NotifyFn; roles: string[] }) {
  const tabsId = useId();
  const [activeSection, setActiveSection] = useState("search");

  // 1. Order search & quick ticket modal
  const [orderQuery, setOrderQuery] = useState("");
  const [searchingOrders, setSearchingOrders] = useState(false);
  const [hasSearchedOrders, setHasSearchedOrders] = useState(false);
  const [foundOrders, setFoundOrders] = useState<SupportOrder[]>([]);

  const [ticketOrder, setTicketOrder] = useState<SupportOrder | null>(null);
  const [ticketSubject, setTicketSubject] = useState("");
  const [ticketBody, setTicketBody] = useState("");
  const [creatingTicket, setCreatingTicket] = useState(false);

  // 2. Support threads
  const [threads, setThreads] = useState<SupportThread[]>([]);
  const [threadsTotalCount, setThreadsTotalCount] = useState<number | null>(null);
  const [threadsNextCursor, setThreadsNextCursor] = useState<string | null>(null);
  const [threadsHasMore, setThreadsHasMore] = useState(false);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingMoreThreads, setLoadingMoreThreads] = useState(false);
  const [threadsLoadError, setThreadsLoadError] = useState<string | null>(null);
  const [threadsSearch, setThreadsSearch] = useState("");
  const [appliedThreadsSearch, setAppliedThreadsSearch] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [loadingThreadDetail, setLoadingThreadDetail] = useState(false);
  const [loadingEarlierMessages, setLoadingEarlierMessages] = useState(false);
  // Isolate drafts per threadId so switching threads never leaks replyText or closeReason.
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [closeReasonDrafts, setCloseReasonDrafts] = useState<Record<string, string>>({});
  const [sendingReply, setSendingReply] = useState(false);
  const [closingThread, setClosingThread] = useState(false);

  // 3. Claims & legal hold evidence
  const [claims, setClaims] = useState<ClaimSummary[]>([]);
  const [claimsTotalCount, setClaimsTotalCount] = useState<number | null>(null);
  const [claimsNextCursor, setClaimsNextCursor] = useState<string | null>(null);
  const [claimsHasMore, setClaimsHasMore] = useState(false);
  const [loadingClaims, setLoadingClaims] = useState(false);
  const [loadingMoreClaims, setLoadingMoreClaims] = useState(false);
  const [claimsLoadError, setClaimsLoadError] = useState<string | null>(null);
  const [claimsSearch, setClaimsSearch] = useState("");
  const [appliedClaimsSearch, setAppliedClaimsSearch] = useState("");
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [claimDetail, setClaimDetail] = useState<ClaimDetail | null>(null);
  const [orderEvidence, setOrderEvidence] = useState<EvidenceAsset[]>([]);
  const [loadingClaimDetail, setLoadingClaimDetail] = useState(false);
  const [openingEvidenceId, setOpeningEvidenceId] = useState<string | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<EvidencePreview | null>(null);

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

  const threadReqRef = useRef(0);
  const claimReqRef = useRef(0);
  const threadsListReqRef = useRef(0);
  const claimsListReqRef = useRef(0);

  const activeThreadId = threadDetail && threadDetail.thread.id === selectedThreadId ? selectedThreadId : null;
  const replyText = activeThreadId ? (replyDrafts[activeThreadId] ?? "") : "";
  const closeReason = activeThreadId ? (closeReasonDrafts[activeThreadId] ?? "") : "";

  const setActiveReplyText = (value: string) => {
    if (!activeThreadId) return;
    setReplyDrafts((prev) => ({ ...prev, [activeThreadId]: value }));
  };

  const setActiveCloseReason = (value: string) => {
    if (!activeThreadId) return;
    setCloseReasonDrafts((prev) => ({ ...prev, [activeThreadId]: value }));
  };

  const closeEvidencePreview = useCallback(() => {
    setEvidencePreview((prev) => {
      if (prev?.blobUrl) URL.revokeObjectURL(prev.blobUrl);
      return null;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (evidencePreview?.blobUrl) {
        URL.revokeObjectURL(evidencePreview.blobUrl);
      }
    };
  }, [evidencePreview]);

  const handleOpenEvidence = useCallback(
    async (assetId: string, label?: string) => {
      setOpeningEvidenceId(assetId);
      try {
        const response = await fetch(`/api/v1/evidence/${encodeURIComponent(assetId)}/content`, {
          method: "GET",
          credentials: "include",
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new ApiError(
            payload?.error?.code ?? payload?.error?.message ?? "REQUEST_FAILED",
            response.status,
            payload?.error?.details,
          );
        }
        const blob = await response.blob();
        const mimeType = response.headers.get("Content-Type") || blob.type || "application/octet-stream";
        const blobUrl = URL.createObjectURL(blob);
        setEvidencePreview((prev) => {
          if (prev?.blobUrl) URL.revokeObjectURL(prev.blobUrl);
          return {
            assetId,
            label: label || `Файл #${assetId.slice(0, 8)}`,
            mimeType,
            blobUrl,
          };
        });
      } catch (err) {
        notify({ kind: "error", text: formatError(err) });
      } finally {
        setOpeningEvidenceId(null);
      }
    },
    [notify],
  );

  const loadThreads = useCallback(async (queryOverride?: string) => {
    const reqId = ++threadsListReqRef.current;
    const queryText = queryOverride !== undefined ? queryOverride : appliedThreadsSearch;
    setLoadingThreads(true);
    try {
      const page = await fetchPaginatedList<SupportThread>(
        "/support/threads",
        ["threads", "items", "data"],
        { query: queryText },
      );
      if (threadsListReqRef.current !== reqId) return;
      setThreads(page.items);
      setThreadsTotalCount(page.totalCount);
      setThreadsNextCursor(page.nextCursor);
      setThreadsHasMore(page.hasMore);
      setThreadsLoadError(null);
    } catch (err) {
      if (threadsListReqRef.current !== reqId) return;
      const msg = formatError(err);
      setThreadsLoadError(msg);
      notify({ kind: "error", text: msg });
    } finally {
      if (threadsListReqRef.current === reqId) {
        setLoadingThreads(false);
      }
    }
  }, [appliedThreadsSearch, notify]);

  const loadMoreThreads = useCallback(async () => {
    if (!threadsNextCursor) return;
    const reqId = ++threadsListReqRef.current;
    setLoadingMoreThreads(true);
    try {
      const page = await fetchPaginatedList<SupportThread>(
        "/support/threads",
        ["threads", "items", "data"],
        { cursor: threadsNextCursor, query: appliedThreadsSearch },
      );
      if (threadsListReqRef.current !== reqId) return;
      setThreads((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setThreadsTotalCount(page.totalCount);
      setThreadsNextCursor(page.nextCursor);
      setThreadsHasMore(page.hasMore);
      setThreadsLoadError(null);
    } catch (err) {
      if (threadsListReqRef.current !== reqId) return;
      notify({ kind: "error", text: formatError(err) });
    } finally {
      if (threadsListReqRef.current === reqId) {
        setLoadingMoreThreads(false);
      }
    }
  }, [threadsNextCursor, appliedThreadsSearch, notify]);

  const loadThreadDetail = useCallback(
    async (threadId: string) => {
      const reqId = ++threadReqRef.current;
      setSelectedThreadId(threadId);
      setThreadDetail(null);
      setLoadingThreadDetail(true);
      try {
        const res = await api<Record<string, unknown>>(`/support/threads/${threadId}`);
        if (threadReqRef.current !== reqId) return;
        const thread = (res.thread as SupportThread | undefined) ?? (res as unknown as SupportThread);
        const messages = unwrapList<SupportMessage>(res.messages ?? res, ["messages", "items"]);
        setThreadDetail({
          thread,
          messages,
          hasEarlier: Boolean(res.hasEarlier),
          earlierCursor: typeof res.earlierCursor === "string" ? res.earlierCursor : null,
          totalMessages: typeof res.totalMessages === "number" ? res.totalMessages : messages.length,
        });
      } catch (err) {
        if (threadReqRef.current !== reqId) return;
        notify({ kind: "error", text: formatError(err) });
      } finally {
        if (threadReqRef.current === reqId) {
          setLoadingThreadDetail(false);
        }
      }
    },
    [notify],
  );

  const loadEarlierThreadMessages = useCallback(async () => {
    if (!threadDetail?.earlierCursor || !selectedThreadId || threadDetail.thread.id !== selectedThreadId) return;
    const targetId = threadDetail.thread.id;
    const reqId = threadReqRef.current;
    setLoadingEarlierMessages(true);
    try {
      const res = await api<Record<string, unknown>>(
        `/support/threads/${targetId}?beforeCursor=${encodeURIComponent(threadDetail.earlierCursor)}`,
      );
      if (threadReqRef.current !== reqId) return;
      const earlier = unwrapList<SupportMessage>(res.messages ?? res, ["messages", "items"]);
      setThreadDetail((prev) => {
        if (!prev || prev.thread.id !== targetId) return prev;
        const existingIds = new Set(prev.messages.map((m) => m.id));
        const prepended = earlier.filter((m) => !existingIds.has(m.id));
        return {
          ...prev,
          messages: [...prepended, ...prev.messages],
          hasEarlier: Boolean(res.hasEarlier),
          earlierCursor: typeof res.earlierCursor === "string" ? res.earlierCursor : null,
          totalMessages: typeof res.totalMessages === "number" ? res.totalMessages : prev.totalMessages,
        };
      });
    } catch (err) {
      if (threadReqRef.current !== reqId) return;
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setLoadingEarlierMessages(false);
    }
  }, [threadDetail, selectedThreadId, notify]);

  const loadClaims = useCallback(async (queryOverride?: string) => {
    const reqId = ++claimsListReqRef.current;
    const queryText = queryOverride !== undefined ? queryOverride : appliedClaimsSearch;
    setLoadingClaims(true);
    try {
      const page = await fetchPaginatedList<ClaimSummary>(
        "/claims",
        ["claims", "items", "data"],
        { query: queryText },
      );
      if (claimsListReqRef.current !== reqId) return;
      setClaims(page.items);
      setClaimsTotalCount(page.totalCount);
      setClaimsNextCursor(page.nextCursor);
      setClaimsHasMore(page.hasMore);
      setClaimsLoadError(null);
    } catch (err) {
      if (claimsListReqRef.current !== reqId) return;
      const msg = formatError(err);
      setClaimsLoadError(msg);
      notify({ kind: "error", text: msg });
    } finally {
      if (claimsListReqRef.current === reqId) {
        setLoadingClaims(false);
      }
    }
  }, [appliedClaimsSearch, notify]);

  const loadMoreClaims = useCallback(async () => {
    if (!claimsNextCursor) return;
    const reqId = ++claimsListReqRef.current;
    setLoadingMoreClaims(true);
    try {
      const page = await fetchPaginatedList<ClaimSummary>(
        "/claims",
        ["claims", "items", "data"],
        { cursor: claimsNextCursor, query: appliedClaimsSearch },
      );
      if (claimsListReqRef.current !== reqId) return;
      setClaims((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setClaimsTotalCount(page.totalCount);
      setClaimsNextCursor(page.nextCursor);
      setClaimsHasMore(page.hasMore);
      setClaimsLoadError(null);
    } catch (err) {
      if (claimsListReqRef.current !== reqId) return;
      notify({ kind: "error", text: formatError(err) });
    } finally {
      if (claimsListReqRef.current === reqId) {
        setLoadingMoreClaims(false);
      }
    }
  }, [claimsNextCursor, appliedClaimsSearch, notify]);

  const loadClaimAndEvidence = useCallback(
    async (claimId: string, knownOrderId?: string) => {
      const reqId = ++claimReqRef.current;
      setSelectedClaimId(claimId);
      setClaimDetail(null);
      setOrderEvidence([]);
      setLoadingClaimDetail(true);
      try {
        const claimPromise = api<Record<string, unknown>>(`/claims/${claimId}`);
        const evidencePromise = knownOrderId
          ? api<unknown>(`/evidence/order/${knownOrderId}`)
          : Promise.resolve(null);

        const [claimRes, preloadedEvidenceRes] = await Promise.all([claimPromise, evidencePromise]);
        if (claimReqRef.current !== reqId) return;

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
          if (claimReqRef.current !== reqId) return;
        }
        setOrderEvidence(unwrapList<EvidenceAsset>(evidenceRes, ["assets", "evidence", "items"]));
      } catch (err) {
        if (claimReqRef.current !== reqId) return;
        notify({ kind: "error", text: formatError(err) });
      } finally {
        if (claimReqRef.current === reqId) {
          setLoadingClaimDetail(false);
        }
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
    if (trimmed.length < 4) {
      notify({ kind: "error", text: "Введите минимум 4 символа номера заказа (LA-...) или телефона (+7...)" });
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
    setTicketSubject(`Обращение по заказу ${order.publicNumber}`);
    setTicketBody("");
  }

  async function handleCreateTicket(e: FormEvent) {
    e.preventDefault();
    if (!ticketOrder) return;
    const subject = ticketSubject.trim();
    const body = ticketBody.trim();
    if (subject.length < 3) {
      notify({ kind: "error", text: "Тема обращения должна содержать минимум 3 символа" });
      return;
    }
    if (body.length < 3) {
      notify({ kind: "error", text: "Текст обращения должен содержать минимум 3 символа" });
      return;
    }
    setCreatingTicket(true);
    try {
      const res = await api<Record<string, unknown>>("/support/threads", {
        method: "POST",
        body: {
          orderId: ticketOrder.id,
          subject,
          body,
        },
      });
      const createdThread = (res.thread as SupportThread | undefined) ?? (res as unknown as SupportThread);
      const createdId = (typeof res.threadId === "string" ? res.threadId : undefined) ?? createdThread?.id;
      setTicketOrder(null);
      setTicketSubject("");
      setTicketBody("");
      notify({ kind: "ok", text: `Обращение по заказу ${ticketOrder.publicNumber} зарегистрировано` });
      await loadThreads();
      if (createdId) {
        await loadThreadDetail(createdId);
        setActiveSection("threads");
      }
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setCreatingTicket(false);
    }
  }

  async function handleSendReply(e: FormEvent) {
    e.preventDefault();
    if (!threadDetail || threadDetail.thread.id !== selectedThreadId) return;
    const targetThreadId = threadDetail.thread.id;
    const trimmed = replyText.trim();
    if (!trimmed) {
      notify({ kind: "error", text: "Введите текст ответа" });
      return;
    }
    setSendingReply(true);
    try {
      await api(`/support/threads/${targetThreadId}/messages`, {
        method: "POST",
        body: { body: trimmed },
      });
      setReplyDrafts((prev) => {
        const next = { ...prev };
        delete next[targetThreadId];
        return next;
      });
      notify({ kind: "ok", text: "Сообщение отправлено клиенту" });
      await Promise.all([loadThreadDetail(targetThreadId), loadThreads()]);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setSendingReply(false);
    }
  }

  async function handleCloseThread() {
    if (!threadDetail || threadDetail.thread.id !== selectedThreadId) return;
    const targetThreadId = threadDetail.thread.id;
    // The route requires a reason of at least three characters: an empty body was rejected with
    // 400, so the "Закрыть обращение" button never worked.
    const reason = closeReason.trim();
    if (reason.length < 3) {
      notify({ kind: "error", text: "Укажите причину закрытия обращения" });
      return;
    }
    setClosingThread(true);
    try {
      await api(`/support/threads/${targetThreadId}/close`, {
        method: "POST",
        body: { reason },
      });
      notify({ kind: "ok", text: "Обращение закрыто" });
      setCloseReasonDrafts((prev) => {
        const next = { ...prev };
        delete next[targetThreadId];
        return next;
      });
      await Promise.all([loadThreadDetail(targetThreadId), loadThreads()]);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setClosingThread(false);
    }
  }

  async function handleProposeCompensation(e: FormEvent) {
    e.preventDefault();
    if (!claimDetail || claimDetail.claim.id !== selectedClaimId) return;
    const targetClaimId = claimDetail.claim.id;
    const targetOrderId = claimDetail.claim.orderId;
    const parsed = Number(compRub.replace(",", "."));
    const amountKopeks = Math.round(parsed * 100);
    if (!Number.isFinite(parsed) || amountKopeks <= 0) {
      notify({ kind: "error", text: "Введите корректную сумму компенсации в рублях" });
      return;
    }
    setSubmittingComp(true);
    try {
      await api(`/claims/${targetClaimId}/compensations`, {
        method: "POST",
        body: { amountKopeks },
      });
      setCompModalOpen(false);
      setCompRub("");
      notify({ kind: "ok", text: `Компенсация ${money(amountKopeks)} предложена` });
      await Promise.all([
        loadClaims(),
        loadClaimAndEvidence(targetClaimId, targetOrderId),
      ]);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setSubmittingComp(false);
    }
  }

  async function handleSubmitDecision(e: FormEvent) {
    e.preventDefault();
    if (!claimDetail || claimDetail.claim.id !== selectedClaimId) return;
    const targetClaimId = claimDetail.claim.id;
    const targetOrderId = claimDetail.claim.orderId;
    const rationale = decisionRationale.trim();
    if (rationale.length < 10) {
      notify({ kind: "error", text: "Обоснование решения должно содержать минимум 10 символов" });
      return;
    }
    setSubmittingDecision(true);
    try {
      await api(`/claims/${targetClaimId}/decision`, {
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
        loadClaimAndEvidence(targetClaimId, targetOrderId),
      ]);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setSubmittingDecision(false);
    }
  }

  async function handleReopenClaim(e: FormEvent) {
    e.preventDefault();
    if (!claimDetail || claimDetail.claim.id !== selectedClaimId) return;
    const targetClaimId = claimDetail.claim.id;
    const targetOrderId = claimDetail.claim.orderId;
    const reason = reopenReason.trim();
    if (reason.length < 5) {
      notify({ kind: "error", text: "Причина переоткрытия должна содержать минимум 5 символов" });
      return;
    }
    setSubmittingReopen(true);
    try {
      await api(`/claims/${targetClaimId}/reopen`, {
        method: "POST",
        body: { reason },
      });
      setReopenModalOpen(false);
      setReopenReason("");
      notify({ kind: "ok", text: "Претензия переоткрыта" });
      await Promise.all([
        loadClaims(),
        loadClaimAndEvidence(targetClaimId, targetOrderId),
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
  const activeHoldsCount = claimDetail
    ? claimDetail.evidenceHolds.filter((h) => !h.releasedAt && h.active !== false).length
    : null;

  const sectionTabs = [
    { id: "search", label: "Поиск заказа", icon: Search },
    { id: "threads", label: "Обращения клиентов", icon: MessageSquare },
    { id: "claims", label: "Претензии", icon: ShieldAlert },
    { id: "reviews", label: "Отзывы", icon: Star },
  ];

  return (
    <div className="workspace-grid">
      <PageHeader
        eyebrow="Клиентская поддержка"
        title="Обращения клиентов и претензии"
        lede="Поиск заказа и регистрация обращения, переписка с клиентом, разбор претензий с защищёнными доказательствами и модерация отзывов."
      />

      <StatGrid>
        <StatTile
          label="Обращения"
          value={threadsTotalCount ?? threads.length}
          icon={<MessageSquare size={16} aria-hidden="true" />}
          tone="accent"
        />
        <StatTile
          label="Претензии"
          value={claimsTotalCount ?? claims.length}
          icon={<ShieldAlert size={16} aria-hidden="true" />}
        />
        <StatTile
          label="Отзывы"
          value={reviews.length}
          icon={<Star size={16} aria-hidden="true" />}
        />
        <StatTile
          label="Активные удержания"
          value={activeHoldsCount === null ? "—" : activeHoldsCount}
          icon={<Lock size={16} aria-hidden="true" />}
        />
      </StatGrid>

      <Tabs
        idPrefix={tabsId}
        items={sectionTabs.map((tab) => ({
          id: tab.id,
          label: (
            <>
              <tab.icon size={16} aria-hidden="true" />
              <span>{tab.label}</span>
            </>
          ),
        }))}
        value={activeSection}
        onChange={setActiveSection}
        label="Разделы поддержки и претензий"
      />

      {/* 1. Поиск заказа и регистрация обращения */}
      <TabPanel idPrefix={tabsId} id="search" active={activeSection === "search"}>
        <Card>
          <CardHeader
            title={
              <span className="row row--tight">
                <Search size={18} aria-hidden="true" />
                <span>Поиск заказа и регистрация обращения</span>
              </span>
            }
          />
          <CardBody>
            <form onSubmit={handleOrderSearch} className="stack">
              <Input
                label="Номер заказа (LA-...) или телефон (+7...)"
                type="text"
                value={orderQuery}
                onChange={(e) => setOrderQuery(e.target.value)}
                placeholder="Например: LA-2026-0001 или +79990001122"
              />
              <div className="button-row">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={searchingOrders}
                  leadingIcon={<Search size={16} aria-hidden="true" />}
                >
                  {searchingOrders ? "Поиск..." : "Найти заказ"}
                </Button>
              </div>
            </form>

            {hasSearchedOrders && (
              <>
                {foundOrders.length === 0 ? (
                  <EmptyState
                    icon={<Search size={20} aria-hidden="true" />}
                    title="Заказы по вашему запросу не найдены."
                  />
                ) : (
                  <div className="data-list">
                    {foundOrders.map((order) => (
                      <div className="data-row" key={order.id}>
                        <span className="data-row__main">
                          <span className="row row--tight">
                            <strong>{order.publicNumber}</strong>
                            <Badge tone={orderStateTone(order.lifecycleState)}>
                              {stateLabel(ORDER_STATE_LABELS, order.lifecycleState)}
                            </Badge>
                          </span>
                          <span className="muted row row--tight">
                            <span>
                              Создан: {dt(order.createdAt)}
                              {order.customerPhone ? ` · ${order.customerPhone}` : ""}
                              {order.totalKopeks !== undefined ? ` · ${money(order.totalKopeks)}` : ""}
                            </span>
                          </span>
                        </span>
                        <Button
                          variant="primary"
                          onClick={() => openTicketModal(order)}
                          leadingIcon={<MessageSquarePlus size={16} aria-hidden="true" />}
                        >
                          Открыть тикет по заказу
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardBody>
        </Card>
      </TabPanel>

      {/* 2. Обращения клиентов */}
      <TabPanel idPrefix={tabsId} id="threads" active={activeSection === "threads"}>
        <div className="grid-two">
          <Card>
            <CardHeader
              title={
                <span className="row row--tight">
                  <MessageSquare size={18} aria-hidden="true" />
                  <span>Обращения клиентов</span>
                </span>
              }
              subtitle={
                threadsTotalCount !== null
                  ? `Показано ${threads.length} из ${threadsTotalCount}`
                  : undefined
              }
              actions={
                <Button
                  variant="ghost"
                  onClick={() => void loadThreads()}
                  disabled={loadingThreads}
                  leadingIcon={<RefreshCw size={15} aria-hidden="true" />}
                >
                  {loadingThreads ? "Обновление..." : "Обновить"}
                </Button>
              }
            />
            <CardBody>
              <form
                className="row row--tight"
                style={{ marginBlockEnd: 12 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = threadsSearch.trim();
                  setAppliedThreadsSearch(next);
                  void loadThreads(next);
                }}
              >
                <Input
                  aria-label="Поиск обращений по теме или номеру заказа"
                  type="text"
                  value={threadsSearch}
                  onChange={(e) => setThreadsSearch(e.target.value)}
                  placeholder="Поиск по теме или номеру заказа…"
                />
                <Button type="submit" variant="secondary" size="sm" disabled={loadingThreads}>
                  Найти
                </Button>
                {appliedThreadsSearch && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={loadingThreads}
                    onClick={() => {
                      setThreadsSearch("");
                      setAppliedThreadsSearch("");
                      void loadThreads("");
                    }}
                  >
                    Сбросить
                  </Button>
                )}
              </form>

              {threadsLoadError && (
                <div className="alert-banner" role="alert" style={{ marginBlockEnd: 12 }}>
                  <AlertTriangle size={16} aria-hidden="true" />
                  <span>Не удалось загрузить обращения: {threadsLoadError}</span>
                </div>
              )}

              {threads.length === 0 ? (
                loadingThreads ? (
                  <p className="muted">Загрузка обращений...</p>
                ) : threadsLoadError ? null : (
                  <EmptyState
                    icon={<MessageSquare size={20} aria-hidden="true" />}
                    title="Обращений пока нет."
                  />
                )
              ) : (
                <>
                  <div className="data-list">
                    {threads.map((t) => {
                      const isSelected = t.id === selectedThreadId;
                      const orderRef = t.orderPublicNumber ?? t.publicNumber;
                      const threadState = t.state ?? t.status ?? "open";
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className={isSelected ? "data-row selected" : "data-row"}
                          onClick={() => void loadThreadDetail(t.id)}
                        >
                          <span className="data-row__main">
                            <span className="row row--tight">
                              <span>
                                {t.subject ||
                                  (orderRef ? `Заказ ${orderRef}` : `Тикет #${t.id.slice(0, 8)}`)}
                              </span>
                            </span>
                            <span className="muted row row--tight">
                              <span>
                                {orderRef ? `Заказ ${orderRef} · ` : ""}
                                {t.channel ? `${stateLabel(CHANNEL_LABELS, t.channel)} · ` : ""}
                                {dt(t.createdAt)}
                              </span>
                            </span>
                          </span>
                          <Badge tone={threadStatusTone(threadState)}>
                            {stateLabel(THREAD_STATUS_LABELS, threadState)}
                          </Badge>
                        </button>
                      );
                    })}
                  </div>
                  {threadsHasMore && (
                    <div className="button-row" style={{ marginBlockStart: 12 }}>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={loadingThreads || loadingMoreThreads}
                        onClick={() => void loadMoreThreads()}
                      >
                        {loadingMoreThreads ? "Загрузка…" : "Загрузить ещё"}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CardBody>
          </Card>

          <Card quiet className="stack">
            {loadingThreadDetail ? (
              <p className="muted">Загрузка переписки...</p>
            ) : !threadDetail ? (
              <EmptyState
                icon={<MessageSquare size={20} aria-hidden="true" />}
                title="Обращение не выбрано"
                text="Выберите обращение слева, чтобы просмотреть переписку и ответить клиенту."
              />
            ) : (
              <>
                <div className="stack stack--tight">
                  <h3 className="section-title">
                    {threadDetail.thread.subject || `Обращение #${threadDetail.thread.id.slice(0, 8)}`}
                  </h3>
                  <span className="muted row row--tight">
                    <span>
                      Статус: {stateLabel(THREAD_STATUS_LABELS, threadDetail.thread.state ?? threadDetail.thread.status ?? "open")}
                      {threadDetail.thread.orderPublicNumber
                        ? ` · Заказ ${threadDetail.thread.orderPublicNumber}`
                        : ""}
                    </span>
                  </span>
                </div>

                {(threadDetail.thread.state ?? threadDetail.thread.status ?? "open") !== "closed" && (
                  <div className="row row--tight">
                    <Input
                      aria-label="Причина закрытия обращения"
                      placeholder="Причина закрытия"
                      value={closeReason}
                      onChange={(event) => setActiveCloseReason(event.target.value)}
                    />
                    <Button
                      variant="ghost"
                      onClick={() => void handleCloseThread()}
                      disabled={closingThread}
                      leadingIcon={<CheckCircle2 size={16} aria-hidden="true" />}
                    >
                      {closingThread ? "Закрытие..." : "Закрыть обращение"}
                    </Button>
                  </div>
                )}

                {threadDetail.hasEarlier && threadDetail.earlierCursor && (
                  <div className="button-row">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={loadingEarlierMessages}
                      onClick={() => void loadEarlierThreadMessages()}
                    >
                      {loadingEarlierMessages
                        ? "Загрузка более ранних…"
                        : `Загрузить более ранние сообщения (показано ${threadDetail.messages.length}${threadDetail.totalMessages ? ` из ${threadDetail.totalMessages}` : ""})`}
                    </Button>
                  </div>
                )}

                {threadDetail.messages.length === 0 ? (
                  <EmptyState
                    icon={<MessageSquare size={20} aria-hidden="true" />}
                    title="Сообщений в обращении пока нет."
                  />
                ) : (
                  <div className="data-list">
                    {threadDetail.messages.map((m) => {
                      const label = m.isMine
                        ? "вы"
                        : m.authorKind === "support"
                          ? "сотрудник"
                          : isCustomerMessage(m)
                            ? "клиент"
                            : "сотрудник";
                      const tone: BadgeTone = m.isMine
                        ? "accent"
                        : label === "клиент"
                          ? "info"
                          : "neutral";
                      return (
                        <div className="data-row" key={m.id}>
                          <span className="data-row__main">
                            <span className="row row--tight">
                              <Badge tone={tone}>
                                {label}
                              </Badge>
                              <span className="muted">{dt(m.createdAt)}</span>
                            </span>
                            <span className="row row--tight">
                              <span>{m.body ?? m.text ?? m.message ?? ""}</span>
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {(threadDetail.thread.state ?? threadDetail.thread.status ?? "open") !== "closed" ? (
                  <form onSubmit={handleSendReply} className="stack">
                    <Textarea
                      label="Ответ клиенту"
                      rows={3}
                      value={replyText}
                      onChange={(e) => setActiveReplyText(e.target.value)}
                      placeholder="Введите сообщение для клиента..."
                    />
                    <div className="row row--end">
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={sendingReply}
                        leadingIcon={<Send size={15} aria-hidden="true" />}
                      >
                        {sendingReply ? "Отправка..." : "Отправить"}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className="muted">
                    Обращение закрыто. Отправка новых сообщений недоступна.
                  </p>
                )}
              </>
            )}
          </Card>
        </div>
      </TabPanel>

      {/* 3. Претензии и юридическое удержание доказательств */}
      <TabPanel idPrefix={tabsId} id="claims" active={activeSection === "claims"}>
        <div className="grid-two">
          <Card>
            <CardHeader
              title={
                <span className="row row--tight">
                  <ShieldAlert size={18} aria-hidden="true" />
                  <span>Претензии</span>
                </span>
              }
              subtitle={
                claimsTotalCount !== null
                  ? `Показано ${claims.length} из ${claimsTotalCount}`
                  : undefined
              }
              actions={
                <Button
                  variant="ghost"
                  onClick={() => void loadClaims()}
                  disabled={loadingClaims}
                  leadingIcon={<RefreshCw size={15} aria-hidden="true" />}
                >
                  {loadingClaims ? "Обновление..." : "Обновить"}
                </Button>
              }
            />
            <CardBody>
              <form
                className="row row--tight"
                style={{ marginBlockEnd: 12 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = claimsSearch.trim();
                  setAppliedClaimsSearch(next);
                  void loadClaims(next);
                }}
              >
                <Input
                  aria-label="Поиск претензий по описанию или номеру заказа"
                  type="text"
                  value={claimsSearch}
                  onChange={(e) => setClaimsSearch(e.target.value)}
                  placeholder="Поиск по описанию или номеру заказа…"
                />
                <Button type="submit" variant="secondary" size="sm" disabled={loadingClaims}>
                  Найти
                </Button>
                {appliedClaimsSearch && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={loadingClaims}
                    onClick={() => {
                      setClaimsSearch("");
                      setAppliedClaimsSearch("");
                      void loadClaims("");
                    }}
                  >
                    Сбросить
                  </Button>
                )}
              </form>

              {claimsLoadError && (
                <div className="alert-banner" role="alert" style={{ marginBlockEnd: 12 }}>
                  <AlertTriangle size={16} aria-hidden="true" />
                  <span>Не удалось загрузить претензии: {claimsLoadError}</span>
                </div>
              )}

              {claims.length === 0 ? (
                loadingClaims ? (
                  <p className="muted">Загрузка претензий...</p>
                ) : claimsLoadError ? null : (
                  <EmptyState
                    icon={<ShieldAlert size={20} aria-hidden="true" />}
                    title="Претензий нет."
                  />
                )
              ) : (
                <>
                  <Stagger as="div" className="data-list">
                    {claims.map((c) => {
                      const status = getClaimStatus(c);
                      const isSelected = c.id === selectedClaimId;
                      const orderRef = c.orderPublicNumber ?? c.publicNumber ?? c.orderId;
                      return (
                        <Reveal as="div" key={c.id}>
                          <button
                            type="button"
                            className={isSelected ? "data-row selected" : "data-row"}
                            onClick={() => void loadClaimAndEvidence(c.id, c.orderId)}
                          >
                            <span className="data-row__main">
                              <span className="row row--tight">
                                <span>Заказ {orderRef}</span>
                              </span>
                              <span className="muted row row--tight">
                                <span>
                                  {c.description ?? c.reason ?? c.summary ?? (c.claimType ? stateLabel(CLAIM_TYPE_LABELS, c.claimType) : "Претензия")} · {dt(c.openedAt ?? c.createdAt)}
                                </span>
                              </span>
                            </span>
                            <Badge tone={claimStateTone(status)}>
                              {stateLabel(CLAIM_STATE_LABELS, status)}
                            </Badge>
                          </button>
                        </Reveal>
                      );
                    })}
                  </Stagger>
                  {claimsHasMore && (
                    <div className="button-row" style={{ marginBlockStart: 12 }}>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={loadingClaims || loadingMoreClaims}
                        onClick={() => void loadMoreClaims()}
                      >
                        {loadingMoreClaims ? "Загрузка…" : "Загрузить ещё"}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </CardBody>
          </Card>

          <Card quiet className="stack">
            {loadingClaimDetail ? (
              <p className="muted">Загрузка претензии и защищённых доказательств...</p>
            ) : !claimDetail ? (
              <EmptyState
                icon={<ShieldAlert size={20} aria-hidden="true" />}
                title="Претензия не выбрана"
                text="Выберите претензию слева. При открытии автоматически загружаются доказательства заказа с записью в журнал аудита."
              />
            ) : (
              <>
                <div className="stack stack--tight">
                  <div className="row row--between row--tight">
                    <h3 className="section-title">
                      Претензия #{claimDetail.claim.id.slice(0, 8)} · Заказ{" "}
                      {claimDetail.claim.orderPublicNumber ?? claimDetail.claim.publicNumber ?? claimDetail.claim.orderId}
                    </h3>
                    <Badge tone={claimStateTone(activeClaimStatus)} large>
                      {stateLabel(CLAIM_STATE_LABELS, activeClaimStatus)}
                    </Badge>
                  </div>
                  <span className="muted row row--tight">
                    <span>
                      Создана: {dt(claimDetail.claim.openedAt ?? claimDetail.claim.createdAt)}
                      {claimDetail.claim.claimedAmountKopeks !== undefined
                        ? ` · Заявлено: ${money(claimDetail.claim.claimedAmountKopeks)}`
                        : ""}
                      {claimDetail.claim.compensationKopeks !== undefined && claimDetail.claim.compensationKopeks > 0
                        ? ` · Компенсация: ${money(claimDetail.claim.compensationKopeks)}`
                        : ""}
                    </span>
                  </span>
                  {(claimDetail.claim.description || claimDetail.claim.reason || claimDetail.claim.summary) && (
                    <span className="row row--tight">
                      <span>{claimDetail.claim.description ?? claimDetail.claim.reason ?? claimDetail.claim.summary}</span>
                    </span>
                  )}
                </div>

                <div className="button-row">
                  {["resolved", "decision_pending", "escalated"].includes(activeClaimStatus) && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setCompRub("");
                        setCompModalOpen(true);
                      }}
                      leadingIcon={<Banknote size={16} aria-hidden="true" />}
                    >
                      Предложить компенсацию
                    </Button>
                  )}

                  {canDecideClaims &&
                    ["opened", "triage", "investigating", "decision_pending", "escalated", "reopened"].includes(
                      activeClaimStatus,
                    ) && (
                      <Button
                        variant="primary"
                        onClick={() => {
                          setDecisionOutcome("resolved");
                          setDecisionRationale("");
                          setDecisionModalOpen(true);
                        }}
                        leadingIcon={<Scale size={16} aria-hidden="true" />}
                      >
                        Вынести решение
                      </Button>
                    )}

                  {canReopenClaim && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setReopenReason("");
                        setReopenModalOpen(true);
                      }}
                      leadingIcon={<RotateCcw size={16} aria-hidden="true" />}
                    >
                      Переоткрыть претензию
                    </Button>
                  )}
                </div>

                {claimDetail.items.length > 0 && (
                  <div className="stack stack--tight">
                    <h4 className="section-title">Позиции претензии</h4>
                    <div className="data-list">
                      {claimDetail.items.map((item) => (
                        <div className="data-row" key={item.id}>
                          <span className="data-row__main">
                            <span className="row row--tight">
                              <strong>
                                {item.title ?? item.name ?? item.description ?? item.issue ?? `Позиция #${item.id.slice(0, 6)}`}
                              </strong>
                            </span>
                            {item.description && item.title ? (
                              <span className="muted row row--tight">
                                <span>{item.description}</span>
                              </span>
                            ) : null}
                          </span>
                          {(item.claimedAmountKopeks ?? item.amountKopeks) !== undefined ? (
                            <span className="mono">
                              {money((item.claimedAmountKopeks ?? item.amountKopeks) as number)}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="stack stack--tight">
                  <h4 className="section-title row row--tight">
                    <Lock size={15} aria-hidden="true" />
                    <span>Доказательства и юридическое удержание</span>
                  </h4>
                  <span className="muted row row--tight">
                    <span>
                      Доступ к доказательствам заказа зафиксирован в журнале аудита. Активных удержаний: {activeHoldsCount}.
                    </span>
                  </span>
                  {orderEvidence.length === 0 && claimDetail.evidenceHolds.length === 0 ? (
                    <EmptyState
                      icon={<Lock size={20} aria-hidden="true" />}
                      title="Связанные доказательства отсутствуют."
                    />
                  ) : orderEvidence.length > 0 ? (
                    <div className="data-list">
                      {orderEvidence.map((asset) => {
                        const held = isAssetOnLegalHold(asset, claimDetail.evidenceHolds);
                        const servable =
                          !asset.status ||
                          asset.status === "verified" ||
                          asset.status === "legal_hold" ||
                          asset.status === "retained";
                        const fileLabel = `Файл #${asset.id.slice(0, 8)}`;
                        return (
                          <div className="data-row" key={asset.id}>
                            <span className="data-row__main">
                              <span className="row row--tight">
                                <code>{fileLabel}</code>
                                {asset.mimeType ? <span className="muted">{asset.mimeType}</span> : null}
                              </span>
                              <span className="muted row row--tight">
                                <span>
                                  SHA-256: <code>{getHashPrefix(asset)}</code>
                                  {asset.purpose ? ` · Назначение: ${stateLabel(EVIDENCE_PURPOSE_LABELS, asset.purpose)}` : ""}
                                </span>
                              </span>
                            </span>
                            <span className="row row--tight">
                              {held && <Badge tone="warn">Юридическое удержание</Badge>}
                              {servable && (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="sm"
                                  disabled={openingEvidenceId === asset.id}
                                  leadingIcon={<Eye size={14} aria-hidden="true" />}
                                  onClick={() => void handleOpenEvidence(asset.id, fileLabel)}
                                >
                                  {openingEvidenceId === asset.id ? "Загрузка…" : "Открыть"}
                                </Button>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="data-list">
                      {claimDetail.evidenceHolds.map((hold, idx) => {
                        const holdAssetId = hold.evidenceAssetId ?? hold.assetId;
                        const holdLabel = holdAssetId
                          ? `Файл #${holdAssetId.slice(0, 8)}`
                          : `Удержание #${idx + 1}`;
                        return (
                          <div className="data-row" key={hold.id ?? hold.assetId ?? idx}>
                            <span className="data-row__main">
                              <span className="row row--tight">
                                <code>{holdLabel}</code>
                              </span>
                              {hold.reason ? (
                                <span className="muted row row--tight">
                                  <span>{hold.reason}</span>
                                </span>
                              ) : null}
                            </span>
                            <span className="row row--tight">
                              {!hold.releasedAt && hold.active !== false && (
                                <Badge tone="warn">Юридическое удержание</Badge>
                              )}
                              {holdAssetId && (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="sm"
                                  disabled={openingEvidenceId === holdAssetId}
                                  leadingIcon={<Eye size={14} aria-hidden="true" />}
                                  onClick={() => void handleOpenEvidence(holdAssetId, holdLabel)}
                                >
                                  {openingEvidenceId === holdAssetId ? "Загрузка…" : "Открыть"}
                                </Button>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="stack stack--tight">
                  <h4 className="section-title row row--tight">
                    <FileText size={15} aria-hidden="true" />
                    <span>История решений</span>
                  </h4>
                  {claimDetail.decisions.length === 0 ? (
                    <EmptyState
                      icon={<FileText size={20} aria-hidden="true" />}
                      title="Решения по претензии ещё не выносились."
                    />
                  ) : (
                    <div className="data-list">
                      {claimDetail.decisions.map((d) => (
                        <div className="data-row" key={d.id}>
                          <span className="data-row__main">
                            <span className="row row--tight">
                              <Badge tone={claimStateTone(d.outcome)}>
                                {stateLabel(CLAIM_STATE_LABELS, d.outcome)}
                              </Badge>
                              <span className="muted">{dt(d.decidedAt ?? d.createdAt)}</span>
                            </span>
                            {(d.rationale ?? d.reason) && (
                              <span className="row row--tight">
                                <span>{d.rationale ?? d.reason}</span>
                              </span>
                            )}
                            {d.compensationKopeks !== undefined && d.compensationKopeks > 0 && (
                              <span className="muted row row--tight">
                                <span>Компенсация: {money(d.compensationKopeks)}</span>
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </Card>
        </div>
      </TabPanel>

      {/* 4. Модерация отзывов */}
      <TabPanel idPrefix={tabsId} id="reviews" active={activeSection === "reviews"}>
        <Card>
          <CardHeader
            title={
              <span className="row row--tight">
                <Star size={18} aria-hidden="true" />
                <span>Модерация отзывов</span>
              </span>
            }
            actions={
              <Button
                variant="ghost"
                onClick={() => void loadReviews()}
                disabled={loadingReviews}
                leadingIcon={<RefreshCw size={15} aria-hidden="true" />}
              >
                {loadingReviews ? "Обновление..." : "Обновить"}
              </Button>
            }
          />
          <CardBody>
            {reviews.length === 0 ? (
              <EmptyState
                icon={<Star size={20} aria-hidden="true" />}
                title="Опубликованных отзывов пока нет."
              />
            ) : (
              <div className="data-list">
                {reviews.map((review) => {
                  const isHidden = review.status === "hidden" || Boolean(review.hiddenAt);
                  return (
                    <div className="data-row" key={review.id}>
                      <span className="data-row__main">
                        <span className="row row--tight">
                          <span className="row row--tight">
                            <Star size={15} aria-hidden="true" />
                            <strong>{review.rating} / 5</strong>
                          </span>
                          <span className="row row--tight muted">
                            <ThumbsUp size={14} aria-hidden="true" />
                            <span>{review.likeCount}</span>
                          </span>
                          <span className="muted">{dt(review.createdAt)}</span>
                          {isHidden && <Badge tone="neutral">Скрыт</Badge>}
                        </span>
                        <span className="row row--tight">
                          <span>{review.body}</span>
                        </span>
                        {review.hideReason && (
                          <span className="muted row row--tight">
                            <span>Причина скрытия: {review.hideReason}</span>
                          </span>
                        )}
                      </span>

                      {!isHidden && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setHideReviewTarget(review);
                            setHideReason("");
                          }}
                          leadingIcon={<EyeOff size={15} aria-hidden="true" />}
                        >
                          Скрыть с причиной
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>
      </TabPanel>

      {/* Modal: Открыть тикет по заказу */}
      <ModalDialog
        open={ticketOrder !== null}
        title={ticketOrder ? `Открыть тикет по заказу ${ticketOrder.publicNumber}` : "Открыть тикет по заказу"}
        onClose={() => setTicketOrder(null)}
      >
        <form onSubmit={handleCreateTicket} className="stack">
          <Input
            label="Тема обращения"
            type="text"
            value={ticketSubject}
            onChange={(e) => setTicketSubject(e.target.value)}
            placeholder="Краткая тема обращения"
          />

          <Textarea
            label="Описание обращения"
            rows={4}
            value={ticketBody}
            onChange={(e) => setTicketBody(e.target.value)}
            placeholder="Суть звонка или сообщения клиента..."
          />

          <div className="row row--end row--tight">
            <Button variant="ghost" onClick={() => setTicketOrder(null)}>
              Отмена
            </Button>
            <Button type="submit" variant="primary" disabled={creatingTicket}>
              {creatingTicket ? "Создание..." : "Создать обращение"}
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal: Предложить компенсацию */}
      <ModalDialog
        open={compModalOpen}
        title="Предложить компенсацию"
        onClose={() => setCompModalOpen(false)}
      >
        <form onSubmit={handleProposeCompensation} className="stack">
          <Input
            label="Сумма компенсации (руб.)"
            type="number"
            min="1"
            step="0.01"
            value={compRub}
            onChange={(e) => setCompRub(e.target.value)}
            placeholder="Например: 500"
            hint={
              Number.isFinite(compPreviewKopeks) && compPreviewKopeks > 0 ? (
                <span>
                  К начислению: {money(compPreviewKopeks)} ({compPreviewKopeks} коп.)
                </span>
              ) : undefined
            }
          />

          <div className="row row--end row--tight">
            <Button variant="ghost" onClick={() => setCompModalOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" variant="primary" disabled={submittingComp}>
              {submittingComp ? "Отправка..." : "Предложить компенсацию"}
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal: Вынести решение */}
      <ModalDialog
        open={decisionModalOpen}
        title="Вынести решение по претензии"
        onClose={() => setDecisionModalOpen(false)}
      >
        <form onSubmit={handleSubmitDecision} className="stack">
          <Select
            label="Итог рассмотрения"
            value={decisionOutcome}
            onChange={(e) => setDecisionOutcome(e.target.value as "resolved" | "denied_with_reason")}
          >
            <option value="resolved">Удовлетворить претензию</option>
            <option value="denied_with_reason">Отклонить с обоснованием</option>
          </Select>

          <Textarea
            label="Обоснование решения (минимум 10 символов)"
            rows={4}
            value={decisionRationale}
            onChange={(e) => setDecisionRationale(e.target.value)}
            placeholder="Укажите подробное обоснование на основе проверенных доказательств..."
            hint={<span>Символов: {decisionRationale.trim().length} / 10 минимум</span>}
          />

          <div className="row row--end row--tight">
            <Button variant="ghost" onClick={() => setDecisionModalOpen(false)}>
              Отмена
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submittingDecision || decisionRationale.trim().length < 10}
            >
              {submittingDecision ? "Сохранение..." : "Вынести решение"}
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal: Переоткрыть претензию */}
      <ModalDialog
        open={reopenModalOpen}
        title="Переоткрыть претензию"
        onClose={() => setReopenModalOpen(false)}
      >
        <form onSubmit={handleReopenClaim} className="stack">
          <Textarea
            label="Причина переоткрытия (минимум 5 символов)"
            rows={3}
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value)}
            placeholder="Опишите основание для пересмотра претензии..."
            hint={<span>Символов: {reopenReason.trim().length} / 5 минимум</span>}
          />

          <div className="row row--end row--tight">
            <Button variant="ghost" onClick={() => setReopenModalOpen(false)}>
              Отмена
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submittingReopen || reopenReason.trim().length < 5}
            >
              {submittingReopen ? "Обработка..." : "Переоткрыть претензию"}
            </Button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal: Просмотр защищённого доказательства */}
      <ModalDialog
        open={evidencePreview !== null}
        title={evidencePreview ? `Просмотр доказательства · ${evidencePreview.label}` : "Просмотр доказательства"}
        onClose={closeEvidencePreview}
      >
        {evidencePreview && (
          <div className="stack">
            {evidencePreview.mimeType.startsWith("image/") ? (
              <img
                src={evidencePreview.blobUrl}
                alt={evidencePreview.label}
                style={{ maxWidth: "100%", maxHeight: "65vh", objectFit: "contain", borderRadius: 8 }}
              />
            ) : evidencePreview.mimeType === "application/pdf" ? (
              <iframe
                src={evidencePreview.blobUrl}
                title={evidencePreview.label}
                style={{ width: "100%", height: "65vh", border: "1px solid var(--border-hairline)", borderRadius: 8 }}
              />
            ) : (
              <p className="muted">
                Предпросмотр для формата <code>{evidencePreview.mimeType}</code> недоступен — откройте файл в новой вкладке.
              </p>
            )}
            <div className="row row--end row--tight">
              <a
                className="ghost btn--sm"
                href={`/api/v1/evidence/${encodeURIComponent(evidencePreview.assetId)}/content`}
                target="_blank"
                rel="noreferrer"
              >
                Открыть в новой вкладке
              </a>
              <Button variant="primary" onClick={closeEvidencePreview}>
                Закрыть
              </Button>
            </div>
          </div>
        )}
      </ModalDialog>

      {/* Modal: Скрыть отзыв с причиной */}
      <ModalDialog
        open={hideReviewTarget !== null}
        title="Скрыть отзыв с причиной"
        onClose={() => setHideReviewTarget(null)}
      >
        <form onSubmit={handleHideReview} className="stack">
          {hideReviewTarget && (
            <p className="muted">
              Отзыв с оценкой {hideReviewTarget.rating}/5 от {dt(hideReviewTarget.createdAt)}
            </p>
          )}
          <Textarea
            label="Причина скрытия (минимум 5 символов)"
            rows={3}
            value={hideReason}
            onChange={(e) => setHideReason(e.target.value)}
            placeholder="Укажите причину модерации отзыва..."
            hint={<span>Символов: {hideReason.trim().length} / 5 минимум</span>}
          />

          <div className="row row--end row--tight">
            <Button variant="ghost" onClick={() => setHideReviewTarget(null)}>
              Отмена
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submittingHide || hideReason.trim().length < 5}
            >
              {submittingHide ? "Сохранение..." : "Скрыть отзыв"}
            </Button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
