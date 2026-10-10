import { authenticatedUserId } from '@/lib/reviews';
import { loadPortfolioView, enrichCosts } from '@/lib/portfolio-storage';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const userId = authenticatedUserId(request);
  if (!userId) return Response.json({ detail: 'Autenticação necessária.' }, { status: 401 });
  try {
    const view = await loadPortfolioView(userId);
    return Response.json({ ...view, positions: await enrichCosts(userId,view) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ detail: 'Não foi possível carregar a carteira agora.' }, { status: 500 });
  }
}
