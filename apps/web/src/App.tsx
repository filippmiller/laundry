import { useEffect, useState } from "react";
import { api } from "./api";
import "./styles.css";
import { DemoConfig, Me, Notice } from "./types";
import { Shell } from "./components/Shell";
import { Router } from "./components/Router";
import { ROLE_LABELS } from "./labels";

function App() {
  const [demo, setDemo] = useState<DemoConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("customer");
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    api<DemoConfig>("/dev/seed", { method: "POST", body: {} })
      .then(config => {
        setDemo(config);
        const first = config.demoUsers.find(user => user.role === "customer");
        if (first) setPhone(first.phone);
      })
      .catch(() => undefined);
    api<Me>("/me").then(setMe).catch(() => undefined);
  }, []);
  
  async function login() {
    if (!demo) return setNotice({ kind: "error", text: "Демо-данные ещё не готовы" });
    try {
      await api("/auth/demo-login", {
        method: "POST",
        body: { organizationId: demo.organizationId, phone, roles: [role] },
      });
      setMe(await api<Me>("/me"));
      setNotice({ kind: "ok", text: "Вы вошли" });
    } catch (error) {
      setNotice({ kind: "error", text: `Вход не удался: ${(error as Error).message}` });
    }
  }

  async function logout() {
    await api("/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    setMe(null);
  }

  return (
    <Shell me={me} logout={logout} notice={notice} setNotice={setNotice}>
      {!me ? (
        <main className="auth-card">
          <h1>Вход в демо</h1>
          <p className="muted">Это локальная среда. В продакшене вход по телефону заменяется реальным провайдером аутентификации.</p>
          <label htmlFor="phone-input">Телефон</label>
          <input id="phone-input" value={phone} onChange={event => setPhone(event.target.value)} placeholder="+79990000001" />
          <label htmlFor="role-input">Роль</label>
          <select id="role-input" value={role} onChange={event => setRole(event.target.value)}>
            {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button onClick={login}>Войти</button>
        </main>
      ) : (
        <Router me={me} demo={demo} setNotice={setNotice} />
      )}
    </Shell>
  );
}

export default App;
