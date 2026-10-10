from datetime import date, datetime
from decimal import Decimal

from wealth.domain import AssetClass, PositionRecord, ProjectionScenario, SourceRef
from wealth.projections import project_scenario
from wealth.recommendations import generate_recommendations


def test_projection_preserves_nominal_value_with_zero_rates_and_flows() -> None:
    points = project_scenario(
        ProjectionScenario(
            name="zero",
            starting_value=Decimal("100000"),
            annual_nominal_return=Decimal("0"),
            annual_inflation=Decimal("0"),
            monthly_contribution=Decimal("0"),
            monthly_withdrawal=Decimal("0"),
            years=2,
        ),
        start_year=2026,
    )
    assert [point.nominal_value for point in points] == [Decimal("100000.00"), Decimal("100000.00")]
    assert [point.real_value for point in points] == [Decimal("100000.00"), Decimal("100000.00")]


def test_fixed_income_concentration_generates_explainable_signal() -> None:
    source = SourceRef("fixture.xlsx", "Renda Fixa", 2, datetime.now(), {})
    positions = [
        PositionRecord(
            owner="Jorge",
            asset_class=AssetClass.FIXED_INCOME,
            product_name="CDB",
            institution="Banco",
            account=None,
            instrument_code="CDB1",
            isin=None,
            issuer="Emissor",
            quantity=Decimal("1"),
            unit_price=Decimal("900000"),
            market_value=Decimal("900000"),
            maturity_date=None,
            reference_date=date(2026, 8, 15),
            source=source,
        ),
        PositionRecord(
            owner="Jorge",
            asset_class=AssetClass.EQUITY,
            product_name="Ação",
            institution="Corretora",
            account=None,
            instrument_code="ACAO3",
            isin=None,
            issuer="Companhia",
            quantity=Decimal("1"),
            unit_price=Decimal("100000"),
            market_value=Decimal("100000"),
            maturity_date=None,
            reference_date=date(2026, 8, 15),
            source=source,
        ),
    ]
    recommendations = generate_recommendations(positions, [], as_of=date(2026, 8, 15))
    codes = {recommendation.code for recommendation in recommendations}
    assert "allocation.fixed_income_concentration" in codes
    assert "risk.issuer_review" in codes
