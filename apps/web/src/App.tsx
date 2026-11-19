import { useEffect, useMemo, useState } from "react";
import { MotionConfig } from "motion/react";
import { ClipboardCheck, PackageCheck, ShieldCheck } from "lucide-react";
import { api } from "./api";
import "./styles.css";
import { DemoConfig, Me, Notice } from "./types";
import { Shell } from "./components/Shell";
import { Router } from "./components/Router";
import { ROLE_LABELS, stateLabel } from "./labels";
import { Button } from "./components/ui/Button";
import { Field } from "./components/ui/Field";
import { Stagger, Reveal } from "./components/ui/Reveal";
import { workspacesForRoles, type WorkspaceKey } from "./workspaces/registry";

function App() {
  const [demo, setDemo] = useState<DemoConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("customer");
  const [notice, setNotice] = useState<Notice>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceKey | null>(null);
  const [busy, setBusy] = useState(false);
  // The session is restored asynchronously; until it settles we must not paint
  // the sign-in screen, or a signed-in user sees it flash on every reload.
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    api<DemoConfig>("/dev/seed", { method: "POST", body: {} })
      .then(config => {
        setDemo(config);
        const first = config.demoUsers.find(user => user.role === "customer");
        if (first) setPhone(first.phone);
      })
      .catch(() => undefined);
    api<Me>("/me")
      .then(result => {
        setMe(result);
        setBooting(false);
      })
      .catch(() => setBooting(false));
  }, []);

  // Only the identities the demo seed created can sign in. Offering the full role list would
  // let a visitor pick a role their identity does not hold and be refused for it.
  const demoIdentities = demo?.demoUsers ?? [];
  const phoneForRole = (value: string) =>
    demoIdentities.find(user => user.role === value)?.phone ?? "";

  function pickRole(value: string) {
    setRole(value);
    setPhone(phoneForRole(value));
  }

  // Open the first workspace this session is allowed to see.
  const available = useMemo(() => workspacesForRoles(me?.roles ?? []), [me?.roles]);
  useEffect(() => {
    if (!me) {
      setActiveWorkspace(null);
      return;
    }
    const options = workspacesForRoles(me.roles);
    if (options.length === 0) {
      setActiveWorkspace(null);
      return;
    }
    setActiveWorkspace(current => (current && options.some(item => item.key === current) ? current : options[0].key));
  }, [me]);

  async function login() {
    if (!demo) {
      setNotice({ kind: "error", text: "Демо-данные ещё не готовы" });
      return;
    }
    setBusy(true);
    try {
      await api("/auth/demo-login", {
        method: "POST",
        body: { organizationId: demo.organizationId, phone, roles: [role] },
      });
      setMe(await api<Me>("/me"));
      setNotice({ kind: "ok", text: "Вы вошли" });
    } catch (error) {
      setNotice({ kind: "error", text: `Вход не удался: ${(error as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api("/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    setMe(null);
    setNotice(null);
  }

  return (
    <MotionConfig reducedMotion="user">
      <Shell
        me={me}
        logout={logout}
        notice={notice}
        setNotice={setNotice}
        workspaces={available}
        activeWorkspace={activeWorkspace}
        onSelectWorkspace={setActiveWorkspace}
      >
        {booting ? (
          <div className="boot" role="status" aria-live="polite">
            <span className="boot__mark" aria-hidden="true" />
            <span className="muted">Готовим рабочее место…</span>
          </div>
        ) : !me ? (
          <Landing
            demo={demo}
            identities={demoIdentities}
            phone={phone}
            role={role}
            busy={busy}
            onPhoneChange={setPhone}
            onRoleChange={pickRole}
            onSubmit={login}
          />
        ) : (
          <Router
            me={me}
            demo={demo}
            setNotice={setNotice}
            activeWorkspace={activeWorkspace}
          />
        )}
      </Shell>
    </MotionConfig>
  );
}

/**
 * The entry screen: an editorial column that explains the service beside a
 * working sign-in form. The split follows the documented 42 / 58 rhythm.
 */
function Landing({
  demo,
  identities,
  phone,
  role,
  busy,
  onPhoneChange,
  onRoleChange,
  onSubmit,
}: {
  demo: DemoConfig | null;
  identities: DemoConfig["demoUsers"];
  phone: string;
  role: string;
  busy: boolean;
  onPhoneChange: (value: string) => void;
  onRoleChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const ready = Boolean(demo);

  return (
    <div className="auth-split">
      <Stagger className="auth-hero">
        <Reveal as="div">
          <span className="eyebrow">Дворовая прачечная и химчистка</span>
          <h1 className="auth-hero__title">Стирка от двери до двери</h1>
          <p className="auth-hero__accent">С поштучной описью и пломбами</p>
          <p className="auth-hero__lede">
            Два тарифа: «Эконом» — мешок, пломба и вес. «Защищённый» — опись каждой вещи,
            фиксация состояния и доказательства на каждом этапе.
          </p>
        </Reveal>

        <Reveal as="ul" className="auth-hero__points">
          <li>
            <ClipboardCheck size={18} aria-hidden="true" />
            <span>
              <strong>Опись, а не «мешок»</strong>
              Ведёте состав иконками — без ввода текста.
            </span>
          </li>
          <li>
            <PackageCheck size={18} aria-hidden="true" />
            <span>
              <strong>Приёмка по пломбе и весу</strong>
              Курьер сверяет заявленное с фактическим и фиксирует расхождение.
            </span>
          </li>
          <li>
            <ShieldCheck size={18} aria-hidden="true" />
            <span>
              <strong>Контроль качества на каждой вещи</strong>
              ОТК проверяет покрытие полного состава заказа.
            </span>
          </li>
        </Reveal>

        <Reveal as="p" className="auth-hero__foot">
          Демонстрационная среда: данные синтетические, оплата тестовая, юридические гейты не пройдены.
        </Reveal>
      </Stagger>

      <Reveal as="section" className="auth-card">
        <header className="auth-card__head">
          <h2 className="panel-title">Вход в демо</h2>
          <p className="muted">
            Выберите одну из подготовленных демо-ролей — под каждой скрыта своя операционная
            картина.
          </p>
        </header>

        <fieldset className="role-picker">
          <legend className="field__label">Роль</legend>
          {identities.map(identity => (
            <label key={identity.role} className="role-card">
              <input
                type="radio"
                name="demo-role"
                value={identity.role}
                checked={role === identity.role}
                onChange={() => onRoleChange(identity.role)}
              />
              <span className="role-card__body">
                <span className="role-card__title">{stateLabel(ROLE_LABELS, identity.role)}</span>
                <span className="role-card__meta mono">{identity.phone}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <Field label="Телефон" hint="Тот же номер, что у выбранной демо-роли.">
          {({ id, describedBy }) => (
            <input
              id={id}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              aria-describedby={describedBy}
              onChange={event => onPhoneChange(event.target.value)}
              placeholder="+79990000001"
            />
          )}
        </Field>

        <Button variant="primary" size="lg" block disabled={!ready || busy} onClick={onSubmit}>
          {busy ? "Входим…" : "Войти"}
        </Button>

        <p className="auth-card__foot muted">
          В продакшене вход по телефону заменяется реальным провайдером аутентификации.
        </p>
      </Reveal>
    </div>
  );
}

export default App;
