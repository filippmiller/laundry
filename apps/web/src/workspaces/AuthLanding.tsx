import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  CalendarClock,
  CheckCircle2,
  Info,
  KeyRound,
  PackageCheck,
  Phone,
  Search,
  ShieldCheck,
  Sparkles,
  Truck,
  UserCheck,
} from "lucide-react";
import { api, dt, type DemoConfig } from "../api";
import { formatError, ORDER_STATE_LABELS, ROLE_LABELS, stateLabel } from "../labels";

export type Me = { userId: string; organizationId: string; roles: string[] };

type Props = {
  demo: DemoConfig | null;
  previewConfig: { previewEnabled: boolean; requiresPreviewKey: boolean };
  onAuthenticated: (me: Me, roleHint?: string) => void;
  notify: (n: { kind: "ok" | "error"; text: string } | null) => void;
};

type AuthTab = "demo" | "otp" | "track";

type TrackResponse = {
  publicNumber?: string;
  state: string;
  updatedAt: string;
};

const FIELD_STYLE = {
  display: "grid",
  gap: 6,
} as const;

const INPUT_STYLE = {
  inlineSize: "100%",
  minBlockSize: 44,
  padding: "9px 12px",
  borderRadius: "var(--radius-sm, 8px)",
  border: "1px solid var(--border-strong, #c9d1d9)",
  background: "var(--bg-surface, #ffffff)",
  color: "var(--ink-primary, #141b24)",
  fontSize: "0.95rem",
} as const;

const FORM_STACK_STYLE = {
  display: "grid",
  gap: 14,
} as const;

export function AuthLanding({ demo, previewConfig, onAuthenticated, notify }: Props) {
  const baseId = useId();
  const [activeTab, setActiveTab] = useState<AuthTab>(() =>
    previewConfig.previewEnabled ? "demo" : "otp",
  );
  const userPickedTabRef = useRef(false);

  useEffect(() => {
    if (previewConfig.previewEnabled && !userPickedTabRef.current) {
      setActiveTab("demo");
    } else if (!previewConfig.previewEnabled && activeTab === "demo") {
      setActiveTab("otp");
    }
  }, [previewConfig.previewEnabled, activeTab]);

  // Demo login state
  const defaultDemoUser = useMemo(
    () => demo?.demoUsers?.find((u) => u.role === "customer") ?? demo?.demoUsers?.[0],
    [demo],
  );
  const [demoPhone, setDemoPhone] = useState<string>(
    () => defaultDemoUser?.phone ?? "+79990000001",
  );
  const [demoRole, setDemoRole] = useState<string>(() => defaultDemoUser?.role ?? "customer");
  const demoTouchedRef = useRef(false);
  const [demoBusy, setDemoBusy] = useState(false);

  useEffect(() => {
    if (!demoTouchedRef.current && defaultDemoUser) {
      setDemoPhone(defaultDemoUser.phone);
      setDemoRole(defaultDemoUser.role);
    }
  }, [defaultDemoUser]);

  // Preview unlock state
  const [previewKey, setPreviewKey] = useState("");
  const [previewUnlocked, setPreviewUnlocked] = useState(false);
  const [unlockBusy, setUnlockBusy] = useState(false);

  // OTP state
  const [otpOrgId, setOtpOrgId] = useState<string>(() => demo?.organizationId ?? "");
  const [otpPhone, setOtpPhone] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [devCodeHint, setDevCodeHint] = useState<string | null>(null);
  const [otpBusy, setOtpBusy] = useState(false);

  // Track state
  const [trackOrgId, setTrackOrgId] = useState<string>(() => demo?.organizationId ?? "");
  const [trackNumber, setTrackNumber] = useState("");
  const [trackPhone, setTrackPhone] = useState("");
  const [trackResult, setTrackResult] = useState<TrackResponse | null>(null);
  const [trackBusy, setTrackBusy] = useState(false);

  useEffect(() => {
    if (demo?.organizationId) {
      setOtpOrgId((prev) => prev || demo.organizationId);
      setTrackOrgId((prev) => prev || demo.organizationId);
    }
  }, [demo?.organizationId]);

  const roleOptions = useMemo(() => {
    const entries = Object.entries(ROLE_LABELS).filter(([key]) => key !== "system_worker");
    const seen = new Set(entries.map(([key]) => key));
    for (const u of demo?.demoUsers ?? []) {
      if (!seen.has(u.role)) {
        entries.push([u.role, stateLabel(ROLE_LABELS, u.role)]);
        seen.add(u.role);
      }
    }
    return entries;
  }, [demo?.demoUsers]);

  const tabs: Array<{ id: AuthTab; label: string; disabled?: boolean }> = [
    { id: "demo", label: "Вход в демо", disabled: !previewConfig.previewEnabled },
    { id: "otp", label: "Вход по телефону (OTP)" },
    { id: "track", label: "Отследить заказ" },
  ];

  const selectTab = (tabId: AuthTab) => {
    if (tabId === "demo" && !previewConfig.previewEnabled) return;
    userPickedTabRef.current = true;
    setActiveTab(tabId);
    notify(null);
  };

  const handleTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const enabledTabs = tabs.filter((t) => !t.disabled);
    const enabledIndex = enabledTabs.findIndex((t) => t.id === tabs[currentIndex]?.id);
    if (enabledIndex === -1) return;

    let nextIndex = -1;
    if (e.key === "ArrowRight") nextIndex = (enabledIndex + 1) % enabledTabs.length;
    else if (e.key === "ArrowLeft")
      nextIndex = (enabledIndex - 1 + enabledTabs.length) % enabledTabs.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = enabledTabs.length - 1;

    if (nextIndex >= 0) {
      e.preventDefault();
      const target = enabledTabs[nextIndex];
      selectTab(target.id);
      const btn = document.getElementById(`${baseId}-tab-${target.id}`);
      btn?.focus();
    }
  };

  async function performDemoLogin(targetPhone: string, targetRole: string) {
    setDemoBusy(true);
    notify(null);
    try {
      await api("/auth/demo-login", {
        method: "POST",
        body: {
          phone: targetPhone.trim(),
          roles: [targetRole],
          ...(demo?.organizationId ? { organizationId: demo.organizationId } : {}),
        },
      });
      const me = await api<Me>("/me");
      onAuthenticated(me, targetRole);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setDemoBusy(false);
    }
  }

  async function handleDemoSubmit(e: FormEvent) {
    e.preventDefault();
    await performDemoLogin(demoPhone, demoRole);
  }

  async function handlePersonaLogin(phone: string, role: string) {
    demoTouchedRef.current = true;
    setDemoPhone(phone);
    setDemoRole(role);
    await performDemoLogin(phone, role);
  }

  async function handlePreviewUnlock() {
    if (!previewKey.trim()) {
      notify({ kind: "error", text: "Введите ключ доступа к демо-среде" });
      return;
    }
    setUnlockBusy(true);
    notify(null);
    try {
      await api("/auth/preview-unlock", {
        method: "POST",
        body: { key: previewKey.trim() },
      });
      setPreviewUnlocked(true);
      notify({ kind: "ok", text: "Демо-доступ открыт" });
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setUnlockBusy(false);
    }
  }

  async function handleOtpRequest(e: FormEvent) {
    e.preventDefault();
    const orgId = (demo?.organizationId || otpOrgId).trim();
    if (!orgId) {
      notify({ kind: "error", text: "Укажите идентификатор организации" });
      return;
    }
    if (!otpPhone.trim()) {
      notify({ kind: "error", text: "Укажите номер телефона" });
      return;
    }
    setOtpBusy(true);
    notify(null);
    try {
      const res = await api<{ devCode?: string }>("/auth/otp/request", {
        method: "POST",
        body: { organizationId: orgId, phone: otpPhone.trim() },
      });
      setOtpRequested(true);
      setDevCodeHint(res?.devCode ?? null);
      notify({ kind: "ok", text: "Код подтверждения отправлен" });
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setOtpBusy(false);
    }
  }

  async function handleOtpVerify(e: FormEvent) {
    e.preventDefault();
    const orgId = (demo?.organizationId || otpOrgId).trim();
    if (!orgId || !otpPhone.trim() || !otpCode.trim()) {
      notify({ kind: "error", text: "Заполните телефон и код подтверждения" });
      return;
    }
    setOtpBusy(true);
    notify(null);
    try {
      await api("/auth/otp/verify", {
        method: "POST",
        body: {
          organizationId: orgId,
          phone: otpPhone.trim(),
          code: otpCode.trim(),
        },
      });
      const me = await api<Me>("/me");
      onAuthenticated(me);
    } catch (err) {
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setOtpBusy(false);
    }
  }

  async function handleTrackSubmit(e: FormEvent) {
    e.preventDefault();
    const orgId = (demo?.organizationId || trackOrgId).trim();
    const num = trackNumber.trim();
    const phone = trackPhone.trim();
    if (!orgId || !num || !phone) {
      notify({ kind: "error", text: "Укажите номер заказа и телефон" });
      return;
    }
    setTrackBusy(true);
    notify(null);
    try {
      const params = new URLSearchParams({
        organizationId: orgId,
        phone,
      });
      const res = await api<TrackResponse>(
        `/track/${encodeURIComponent(num)}?${params.toString()}`,
      );
      setTrackResult(res);
    } catch (err) {
      setTrackResult(null);
      notify({ kind: "error", text: formatError(err) });
    } finally {
      setTrackBusy(false);
    }
  }

  const previewKeyId = `${baseId}-preview-key`;
  const demoPhoneId = `${baseId}-demo-phone`;
  const demoRoleId = `${baseId}-demo-role`;
  const otpOrgInputId = `${baseId}-otp-org`;
  const otpPhoneId = `${baseId}-otp-phone`;
  const otpCodeId = `${baseId}-otp-code`;
  const trackOrgInputId = `${baseId}-track-org`;
  const trackNumberId = `${baseId}-track-number`;
  const trackPhoneId = `${baseId}-track-phone`;

  return (
    <div className="auth-split">
      <section className="panel" aria-labelledby={`${baseId}-editorial-title`}>
        <div className="panel-head">
          <div>
            <span className="pill info" style={{ marginBlockEnd: 10 }}>
              <Sparkles size={14} aria-hidden="true" />
              Соседский сервис ухода за вещами
            </span>
            <h1 id={`${baseId}-editorial-title`} className="panel-title">
              Чисто — дворовая прачечная и химчистка
            </h1>
          </div>
        </div>

        <p className="muted" style={{ marginBlockEnd: 18, lineHeight: 1.55 }}>
          Единый контур приёмки у подъезда, контроля сохранности с пломбами и доставки обратно в
          удобное дворовое окно — от повседневной стирки до деликатной химчистки.
        </p>

        <div className="grid-two" style={{ marginBlockEnd: 16 }}>
          <div className="panel-muted">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBlockEnd: 6 }}>
              <PackageCheck size={18} aria-hidden="true" />
              <strong>Эконом</strong>
            </div>
            <p className="muted" style={{ margin: 0, lineHeight: 1.45 }}>
              Мешок с пломбой по весу. Быстрое оформление у двери без поштучной описи — подходит для
              повседневного белья и домашнего текстиля.
            </p>
          </div>

          <div className="panel-muted">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBlockEnd: 6 }}>
              <ShieldCheck size={18} aria-hidden="true" />
              <strong>Защищённый</strong>
            </div>
            <p className="muted" style={{ margin: 0, lineHeight: 1.45 }}>
              Поштучная опись каждой вещи, фотофиксация состояния на входе и выходе, объявленная
              ценность и прозрачное согласование доплат.
            </p>
          </div>
        </div>

        <div className="panel-muted" style={{ marginBlockEnd: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBlockEnd: 6 }}>
            <CalendarClock size={18} aria-hidden="true" />
            <strong>Общие дворовые окна или выезд вне расписания</strong>
          </div>
          <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
            Плановые общие окна забора и доставки по вашему дому — <strong>бесплатно</strong> за
            счёт объединения рейсов. Если нужно приехать в индивидуальное время вне графика дома,
            доступен отдельный стоп за <strong>+500 ₽</strong>.
          </p>
        </div>

        <div className="panel-muted" style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <Info size={18} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
          <p className="muted" style={{ margin: 0, lineHeight: 1.45 }}>
            <strong>Демо-режим:</strong> тарифы, SMS-коды и платёжные провайдеры в этом стенде
            являются тестовыми нефискальными заглушками; реальные списания и отправка СМС не
            выполняются.
          </p>
        </div>
      </section>

      <section className="panel" aria-label="Авторизация и проверка статуса">
        <div className="tab-bar" role="tablist" aria-label="Способы входа и отслеживания">
          {tabs.map((tab, idx) => {
            const isSelected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                id={`${baseId}-tab-${tab.id}`}
                type="button"
                role="tab"
                className="tab-btn"
                aria-selected={isSelected}
                aria-controls={`${baseId}-tabpanel-${tab.id}`}
                tabIndex={isSelected ? 0 : -1}
                disabled={tab.disabled}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(e) => handleTabKeyDown(e, idx)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeTab === "demo" && previewConfig.previewEnabled && (
          <div
            id={`${baseId}-tabpanel-demo`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-demo`}
          >
            <div className="panel-head">
              <h2 className="section-title" style={{ margin: 0, fontSize: "1.2rem" }}>
                Вход в демо
              </h2>
              <span className="pill ok">Тестовый стенд</span>
            </div>

            {previewConfig.requiresPreviewKey && (
              <div className="panel-muted" style={{ marginBlockEnd: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBlockEnd: 8, flexWrap: "wrap" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                    <KeyRound size={16} aria-hidden="true" />
                    Требуется ключ предпросмотра
                  </span>
                  {previewUnlocked && (
                    <span className="pill ok">
                      <CheckCircle2 size={14} aria-hidden="true" />
                      Доступ открыт
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
                  <div style={{ ...FIELD_STYLE, flex: "1 1 200px" }}>
                    <label htmlFor={previewKeyId}>Ключ демо-доступа</label>
                    <input
                      id={previewKeyId}
                      type="password"
                      value={previewKey}
                      onChange={(e) => setPreviewKey(e.target.value)}
                      placeholder="Введите ключ предпросмотра"
                      autoComplete="off"
                      style={INPUT_STYLE}
                    />
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={unlockBusy}
                    onClick={handlePreviewUnlock}
                  >
                    Открыть демо-доступ
                  </button>
                </div>
              </div>
            )}

            <form onSubmit={handleDemoSubmit} style={FORM_STACK_STYLE}>
              <div style={FIELD_STYLE}>
                <label htmlFor={demoPhoneId}>Телефон</label>
                <input
                  id={demoPhoneId}
                  type="tel"
                  value={demoPhone}
                  onChange={(e) => {
                    demoTouchedRef.current = true;
                    setDemoPhone(e.target.value);
                  }}
                  placeholder="+79990000001"
                  required
                  style={INPUT_STYLE}
                />
              </div>

              <div style={FIELD_STYLE}>
                <label htmlFor={demoRoleId}>Роль в системе</label>
                <select
                  id={demoRoleId}
                  value={demoRole}
                  onChange={(e) => {
                    demoTouchedRef.current = true;
                    setDemoRole(e.target.value);
                  }}
                  style={INPUT_STYLE}
                >
                  {roleOptions.map(([roleKey, roleLabel]) => (
                    <option key={roleKey} value={roleKey}>
                      {roleLabel}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <button type="submit" className="primary" disabled={demoBusy}>
                  Войти
                </button>
              </div>
            </form>

            {demo?.demoUsers && demo.demoUsers.length > 0 && (
              <div style={{ marginBlockStart: 22 }}>
                <h3 className="section-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <UserCheck size={17} aria-hidden="true" />
                  Быстрый вход по роли
                </h3>
                <div className="grid-two">
                  {demo.demoUsers.map((u) => (
                    <button
                      key={`${u.role}-${u.phone}`}
                      type="button"
                      className="ghost"
                      disabled={demoBusy}
                      onClick={() => handlePersonaLogin(u.phone, u.role)}
                      style={{
                        justifyContent: "space-between",
                        textAlign: "left",
                        paddingBlock: 10,
                        height: "auto",
                      }}
                    >
                      <span style={{ display: "grid", gap: 2 }}>
                        <span>{stateLabel(ROLE_LABELS, u.role)}</span>
                        {u.displayName && (
                          <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 400 }}>
                            {u.displayName}
                          </span>
                        )}
                      </span>
                      <span className="mono muted" style={{ fontSize: "0.8125rem", fontWeight: 500 }}>
                        {u.phone}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "otp" && (
          <div
            id={`${baseId}-tabpanel-otp`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-otp`}
          >
            <div className="panel-head">
              <h2 className="section-title" style={{ margin: 0, fontSize: "1.2rem" }}>
                Вход по телефону (OTP)
              </h2>
              <span className="pill">
                <Phone size={14} aria-hidden="true" />
                Одноразовый код
              </span>
            </div>

            <form onSubmit={handleOtpRequest} style={{ ...FORM_STACK_STYLE, marginBlockEnd: 18 }}>
              {!demo?.organizationId && (
                <div style={FIELD_STYLE}>
                  <label htmlFor={otpOrgInputId}>Идентификатор организации</label>
                  <input
                    id={otpOrgInputId}
                    type="text"
                    value={otpOrgId}
                    onChange={(e) => setOtpOrgId(e.target.value)}
                    placeholder="org_..."
                    required
                    style={INPUT_STYLE}
                  />
                </div>
              )}

              <div style={FIELD_STYLE}>
                <label htmlFor={otpPhoneId}>Номер телефона</label>
                <input
                  id={otpPhoneId}
                  type="tel"
                  value={otpPhone}
                  onChange={(e) => setOtpPhone(e.target.value)}
                  placeholder="+79990000001"
                  required
                  style={INPUT_STYLE}
                />
              </div>

              <div>
                <button type="submit" className="secondary" disabled={otpBusy}>
                  Получить код
                </button>
              </div>
            </form>

            {devCodeHint && (
              <div className="panel-muted" style={{ marginBlockEnd: 16 }}>
                <span className="muted">Тестовый код подтверждения (devCode): </span>
                <strong className="mono">{devCodeHint}</strong>
              </div>
            )}

            <form onSubmit={handleOtpVerify} style={FORM_STACK_STYLE}>
              <div style={FIELD_STYLE}>
                <label htmlFor={otpCodeId}>Код подтверждения</label>
                <input
                  id={otpCodeId}
                  type="text"
                  inputMode="numeric"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  placeholder={otpRequested ? "Введите код из СМС" : "Сначала запросите код"}
                  required
                  style={INPUT_STYLE}
                />
              </div>

              <div>
                <button type="submit" className="primary" disabled={otpBusy}>
                  Подтвердить код
                </button>
              </div>
            </form>
          </div>
        )}

        {activeTab === "track" && (
          <div
            id={`${baseId}-tabpanel-track`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-track`}
          >
            <div className="panel-head">
              <h2 className="section-title" style={{ margin: 0, fontSize: "1.2rem" }}>
                Отследить заказ
              </h2>
              <span className="pill">
                <Truck size={14} aria-hidden="true" />
                Без входа
              </span>
            </div>

            <form onSubmit={handleTrackSubmit} style={FORM_STACK_STYLE}>
              {!demo?.organizationId && (
                <div style={FIELD_STYLE}>
                  <label htmlFor={trackOrgInputId}>Идентификатор организации</label>
                  <input
                    id={trackOrgInputId}
                    type="text"
                    value={trackOrgId}
                    onChange={(e) => setTrackOrgId(e.target.value)}
                    placeholder="org_..."
                    required
                    style={INPUT_STYLE}
                  />
                </div>
              )}

              <div style={FIELD_STYLE}>
                <label htmlFor={trackNumberId}>Номер заказа</label>
                <input
                  id={trackNumberId}
                  type="text"
                  value={trackNumber}
                  onChange={(e) => setTrackNumber(e.target.value)}
                  placeholder="LA-0001"
                  required
                  style={INPUT_STYLE}
                />
              </div>

              <div style={FIELD_STYLE}>
                <label htmlFor={trackPhoneId}>Телефон из заказа</label>
                <input
                  id={trackPhoneId}
                  type="tel"
                  value={trackPhone}
                  onChange={(e) => setTrackPhone(e.target.value)}
                  placeholder="+79990000001"
                  required
                  style={INPUT_STYLE}
                />
              </div>

              <div>
                <button type="submit" className="primary" disabled={trackBusy}>
                  <Search size={16} aria-hidden="true" />
                  Проверить статус
                </button>
              </div>
            </form>

            {trackResult && (
              <div className="panel-muted" style={{ marginBlockStart: 18, display: "grid", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontWeight: 700 }}>
                    {trackResult.publicNumber ?? trackNumber.trim()}
                  </span>
                  <span className="pill info">
                    {stateLabel(ORDER_STATE_LABELS, trackResult.state)}
                  </span>
                </div>
                <div className="muted" style={{ fontSize: "0.875rem" }}>
                  Обновлено: <span className="mono">{dt(trackResult.updatedAt)}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
