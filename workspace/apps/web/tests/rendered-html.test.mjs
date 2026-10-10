import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the wealth dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /Patrimônio — Gestão familiar/);
  assert.match(html, /Subtotal coberto pela B3/);
  assert.match(html, /Cobertura parcial/);
  assert.match(html, /Qualidade dos dados/);
  assert.match(html, /role="tab"[^>]*>Visão geral/);
  assert.match(html, /role="tab"[^>]*>Importar/);
  assert.match(html, /role="tab"[^>]*>Renda fixa/);
  assert.match(html, /role="tab"[^>]*>Projeções/);
  assert.match(html, /role="tab"[^>]*>Recomendações/);
  assert.match(html, /role="tabpanel" aria-label="Visão geral"/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/);
});
