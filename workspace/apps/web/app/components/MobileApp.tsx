"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const serverFalse = () => false;
const subscribeNothing = () => () => {};
function subscribeStandalone(onChange: () => void) {
  const media = window.matchMedia("(display-mode: standalone)");
  media.addEventListener("change", onChange);
  window.addEventListener("appinstalled", onChange);
  return () => {
    media.removeEventListener("change", onChange);
    window.removeEventListener("appinstalled", onChange);
  };
}
function getStandaloneSnapshot() {
  return window.matchMedia("(display-mode: standalone)").matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}
function subscribeNetwork(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}
const getOfflineSnapshot = () => !navigator.onLine;
const getIosSnapshot = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const getSecureSnapshot = () => window.isSecureContext;

export default function MobileApp() {
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const standalone = useSyncExternalStore(subscribeStandalone, getStandaloneSnapshot, serverFalse);
  const offline = useSyncExternalStore(subscribeNetwork, getOfflineSnapshot, serverFalse);
  const ios = useSyncExternalStore(subscribeNothing, getIosSnapshot, serverFalse);
  const secure = useSyncExternalStore(subscribeNothing, getSecureSnapshot, serverFalse);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const onInstall = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent); };
    const onInstalled = () => { setInstall(null); setHelp(false); };
    if (window.isSecureContext && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    window.addEventListener("beforeinstallprompt", onInstall); window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstall); window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  async function addApp() {
    if (!install) { setHelp(!help); return; }
    await install.prompt(); await install.userChoice; setInstall(null);
  }
  return <>
    <div className="mobile-app-header">
      <div className="mobile-app-brand"><img src="/juanca-app-180.png" alt="" width={44} height={44} /><div><strong>Juanca</strong><small>Patrimônio familiar</small></div></div>
      {!standalone && <button type="button" className="install-app-button" onClick={addApp} aria-expanded={help}>Instalar app</button>}
    </div>
    {help && <div className="install-app-help" role="region" aria-label="Como instalar Juanca"><strong>Juanca na tela inicial</strong><p>{!secure ? "A instalação como app precisa do endereço HTTPS privado. Por enquanto, você pode usar Juanca nesta página pelo navegador." : ios ? "No Safari, toque em Compartilhar e depois em Adicionar à Tela de Início. Ative Abrir como App, se essa opção aparecer." : "No Chrome, abra o menu ⋮ e escolha Instalar app ou Adicionar à tela inicial."}</p><p>Use a conexão privada com Tailscale e mantenha o computador de Juanca ligado.</p><button type="button" onClick={() => setHelp(false)}>Entendi</button></div>}
    {offline && <p className="app-offline-status" role="status">Sem conexão. Conecte-se para consultar dados atualizados ou enviar mensagens.</p>}
  </>;
}
