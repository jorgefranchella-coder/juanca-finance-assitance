from __future__ import annotations

from decimal import Decimal

from wealth.domain import ProjectionPoint, ProjectionScenario

TWELVE = Decimal("12")


def project_scenario(scenario: ProjectionScenario, *, start_year: int) -> list[ProjectionPoint]:
    if scenario.years < 1 or scenario.years > 80:
        raise ValueError("O horizonte deve estar entre 1 e 80 anos")
    if scenario.annual_inflation <= Decimal("-1") or scenario.annual_nominal_return <= Decimal(
        "-1"
    ):
        raise ValueError("Taxas anuais devem ser maiores que -100%")

    monthly_return = (Decimal("1") + scenario.annual_nominal_return) ** (
        Decimal("1") / TWELVE
    ) - Decimal("1")
    monthly_inflation = (Decimal("1") + scenario.annual_inflation) ** (
        Decimal("1") / TWELVE
    ) - Decimal("1")
    nominal = scenario.starting_value
    inflation_factor = Decimal("1")
    contributions = Decimal("0")
    withdrawals = Decimal("0")
    result: list[ProjectionPoint] = []

    for month in range(1, scenario.years * 12 + 1):
        nominal = nominal * (Decimal("1") + monthly_return)
        nominal += scenario.monthly_contribution - scenario.monthly_withdrawal
        inflation_factor *= Decimal("1") + monthly_inflation
        contributions += scenario.monthly_contribution
        withdrawals += scenario.monthly_withdrawal
        if month % 12 == 0:
            result.append(
                ProjectionPoint(
                    year=start_year + month // 12,
                    nominal_value=nominal.quantize(Decimal("0.01")),
                    real_value=(nominal / inflation_factor).quantize(Decimal("0.01")),
                    contributions=contributions.quantize(Decimal("0.01")),
                    withdrawals=withdrawals.quantize(Decimal("0.01")),
                )
            )
    return result
