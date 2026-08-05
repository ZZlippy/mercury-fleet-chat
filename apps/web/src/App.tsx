import { useEffect, useState } from "react";
import { api, DEMO_MODE, type SessionUser } from "./api";
import { Chat } from "./components/Chat";
import { OperatorDashboard } from "./components/OperatorDashboard";

function DemoBanner() {
  if (!DEMO_MODE) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: "#1f2a44",
        color: "#fff",
        fontSize: 13,
        textAlign: "center",
        padding: "6px 12px",
        letterSpacing: 0.2,
      }}
    >
      静态演示 · 全部为示例数据，操作不会保存也不会发送到真实系统
    </div>
  );
}

export type Portal = "fleet" | "operator";

// GitHub Pages serves the demo build from a subpath (e.g. /mercury-fleet-chat/)
// instead of the domain root, so every root-relative path used at runtime
// (routing checks, history.replaceState targets, hardcoded asset src's) needs
// to account for Vite's configured `base` — import.meta.env.BASE_URL is "/"
// for the normal production build and "/mercury-fleet-chat/" for the demo one.
const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");
export const asset = (path: string) => `${BASE_PATH}${path}`;
function pathWithinApp(): string {
  const full = window.location.pathname;
  const relative = BASE_PATH && full.startsWith(BASE_PATH) ? full.slice(BASE_PATH.length) : full;
  return relative.startsWith("/") ? relative : `/${relative}`;
}
export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}

function portalFromPath(): Portal {
  return pathWithinApp().startsWith("/operator") ? "operator" : "fleet";
}

export function MercuryBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`mercury-brand${compact ? " compact" : ""}`}>
      <img
        className="mercury-mark"
        src={asset("/brand/mercury-mark-256.png")}
        alt="Mercury"
        width={compact ? 28 : 44}
        height={compact ? 28 : 44}
      />
      <span className="brand-copy">
        <strong>Mercury</strong>
        <small>物流协作平台</small>
      </span>
    </div>
  );
}

function Login({
  portal,
  onLogin,
}: {
  portal: Portal;
  onLogin: (session: SessionUser) => void;
}) {
  const demoUsername = portal === "operator" ? "operator1" : "fleet1";
  const prefill = import.meta.env.DEV || DEMO_MODE;
  const [username, setUsername] = useState(prefill ? demoUsername : "");
  const [password, setPassword] = useState(prefill ? "mercury" : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const session = await api.login(portal, username, password);
      window.history.replaceState(null, "", withBase(portal === "operator" ? "/operator" : "/fleet"));
      onLogin(session);
    } catch (e: any) {
      setError(e.body?.error ?? e.message ?? "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={`login-page login-${portal}`}>
      <section className="login-identity">
        <MercuryBrand />
        <div className="login-statement">
          <span>{portal === "operator" ? "OPERATIONS" : "FLEET"}</span>
          <h1>{portal === "operator" ? "运营工作台" : "车队工作空间"}</h1>
          <p>
            {portal === "operator"
              ? "集中处理订单、报价和运输异常。"
              : "每个任务一段独立对话，清晰完成报价与运输反馈。"}
          </p>
        </div>
        <div className="mercury-horizon" aria-hidden="true" />
      </section>

      <section className="login-form-wrap">
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <header>
            <span className="section-kicker">SECURE ACCESS</span>
            <h2>登录{portal === "operator" ? "运营端" : "车队端"}</h2>
          </header>
          <label>
            用户名
            <input
              value={username}
              type="text"
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            密码
            <input
              value={password}
              type="password"
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error ? <div className="form-error">{error}</div> : null}
          <button className="button button-primary button-full" disabled={busy} type="submit">
            {busy ? "正在登录…" : "登录"}
          </button>
          {import.meta.env.DEV ? <p className="demo-note">本地演示账号已预填，密码为 mercury</p> : null}
          {DEMO_MODE ? (
            <p className="demo-note">
              演示账号已预填，任意密码均可登录。
              {portal === "fleet" ? " 可尝试改为 fleet1 / fleet2 / fleet3 / fleet4 查看不同场景。" : ""}
            </p>
          ) : null}
        </form>
      </section>
    </main>
  );
}

export default function App() {
  const portal = portalFromPath();
  const [session, setSession] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    document.title = portal === "operator" ? "Mercury · 运营工作台" : "Mercury · 车队工作空间";
    if (pathWithinApp() === "/") {
      window.history.replaceState(null, "", withBase("/fleet/login"));
    }
    api.session(portal).then(setSession).catch(() => setSession(null)).finally(() => setReady(true));
  }, [portal]);

  const signOut = async () => {
    await api.logout(portal);
    setSession(null);
    window.history.replaceState(null, "", withBase(`/${portal}/login`));
  };

  if (!ready) {
    return (
      <div className="app-loading">
        <DemoBanner />
        <img className="loading-mark" src={asset("/brand/mercury-mark-256.png")} alt="" width={40} height={40} />
        <span>正在连接 Mercury</span>
      </div>
    );
  }

  if (!session) {
    return (
      <>
        <DemoBanner />
        <Login portal={portal} onLogin={setSession} />
      </>
    );
  }
  return (
    <>
      <DemoBanner />
      {portal === "operator"
        ? <OperatorDashboard session={session} onLogout={signOut} />
        : <Chat session={session} onLogout={signOut} />}
    </>
  );
}
