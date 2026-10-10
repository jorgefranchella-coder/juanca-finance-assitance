"use client";

import { useEffect, useState } from "react";

export default function SessionControls() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const original = window.fetch;
    const wrapped: typeof window.fetch = async (...args) => {
      const response = await original.apply(window, args);
      if (response.status === 401) window.location.replace("/login");
      return response;
    };
    window.fetch = wrapped;
    return () => { if (window.fetch === wrapped) window.fetch = original; };
  }, []);

  async function logout() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/logout", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Juanca-Request": "1" }, body: "{}" });
      if (!response.ok) throw new Error("Não foi possível sair. Tente novamente.");
      window.location.replace("/login");
    } catch {
      setError("Não foi possível sair. Verifique a conexão e tente novamente.");
      setBusy(false);
    }
  }

  return <div className="session-controls"><button type="button" onClick={logout} disabled={busy}>{busy ? "Saindo…" : "Sair"}</button>{error && <p role="alert">{error}</p>}</div>;
}
