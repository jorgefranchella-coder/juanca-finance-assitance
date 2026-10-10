from __future__ import annotations

from datetime import date
from decimal import Decimal

from wealth.domain import AssetClass, PositionRecord, Recommendation, ReconciliationIssue


def generate_recommendations(
    positions: list[PositionRecord],
    issues: list[ReconciliationIssue],
    *,
    as_of: date,
) -> list[Recommendation]:
    total = sum((position.market_value for position in positions), Decimal("0"))
    by_class: dict[AssetClass, Decimal] = {}
    by_issuer: dict[str, Decimal] = {}
    maturities_90d = Decimal("0")
    for position in positions:
        by_class[position.asset_class] = (
            by_class.get(position.asset_class, Decimal("0")) + position.market_value
        )
        issuer = position.issuer or position.institution
        by_issuer[issuer] = by_issuer.get(issuer, Decimal("0")) + position.market_value
        if position.maturity_date and 0 <= (position.maturity_date - as_of).days <= 90:
            maturities_90d += position.market_value

    blocked = bool(issues)
    result: list[Recommendation] = []
    defensive = by_class.get(AssetClass.FIXED_INCOME, Decimal("0")) + by_class.get(
        AssetClass.TREASURY, Decimal("0")
    )
    if total and defensive / total > Decimal("0.80"):
        share = defensive / total
        result.append(
            Recommendation(
                code="allocation.fixed_income_concentration",
                severity="medium",
                title="Revisar concentração em renda fixa",
                explanation="A carteira possui mais de 80% em renda fixa bancária e títulos públicos. Isso não implica venda automática; requer comparação com objetivos e tolerância a risco.",
                evidence={"participacao": f"{share:.1%}", "valor": f"{defensive:.2f}"},
                blocked_by_data_quality=blocked,
            )
        )
    concentrated = sorted(
        ((issuer, value) for issuer, value in by_issuer.items() if value > Decimal("250000")),
        key=lambda item: item[1],
        reverse=True,
    )
    if concentrated:
        result.append(
            Recommendation(
                code="risk.issuer_review",
                severity="high",
                title="Validar exposição por emissor e conglomerado",
                explanation="Há emissores acima de R$ 250 mil. O limite deve ser analisado por titular, conglomerado, instituição e regras vigentes; não é uma conclusão automática sobre cobertura.",
                evidence={
                    "emissores": str(len(concentrated)),
                    "maior_exposicao": f"{concentrated[0][0]}: {concentrated[0][1]:.2f}",
                },
                blocked_by_data_quality=blocked,
            )
        )
    if maturities_90d:
        result.append(
            Recommendation(
                code="liquidity.upcoming_maturities",
                severity="info",
                title="Preparar decisão para vencimentos próximos",
                explanation="Há recursos vencendo nos próximos 90 dias. A destinação deve considerar liquidez, alocação-alvo e concentração antes do reinvestimento.",
                evidence={"valor_estimado": f"{maturities_90d:.2f}"},
                blocked_by_data_quality=blocked,
            )
        )
    if issues:
        result.insert(
            0,
            Recommendation(
                code="data.reconciliation_required",
                severity="high",
                title="Resolver pendências antes de recomendar",
                explanation="Existem divergências de posição. Recomendações dependentes desses ativos ficam bloqueadas até a reconciliação.",
                evidence={"pendencias": str(len(issues))},
                blocked_by_data_quality=True,
            ),
        )
    return result
