from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any


class AssetClass(StrEnum):
    EQUITY = "equity"
    BDR = "bdr"
    ETF = "etf"
    FUND = "fund"
    FIXED_INCOME = "fixed_income"
    TREASURY = "treasury"
    OTHER = "other"


class EventType(StrEnum):
    BUY = "buy"
    SELL = "sell"
    TRANSFER_IN = "transfer_in"
    TRANSFER_OUT = "transfer_out"
    MATURITY = "maturity"
    EARLY_REDEMPTION = "early_redemption"
    INTEREST = "interest"
    DIVIDEND = "dividend"
    JCP = "jcp"
    INCOME = "income"
    AMORTIZATION = "amortization"
    CORPORATE_ACTION = "corporate_action"
    UNKNOWN = "unknown"


class LegType(StrEnum):
    ASSET_QUANTITY = "asset_quantity"
    CASH = "cash"
    INCOME = "income"
    PRINCIPAL_RETURN = "principal_return"
    TAX = "tax"
    FEE = "fee"


@dataclass(frozen=True)
class SourceRef:
    file_name: str
    sheet_name: str
    row_number: int
    imported_at: datetime
    raw: dict[str, Any]


@dataclass(frozen=True)
class PositionRecord:
    owner: str
    asset_class: AssetClass
    product_name: str
    institution: str
    account: str | None
    instrument_code: str | None
    isin: str | None
    issuer: str | None
    quantity: Decimal | None
    unit_price: Decimal | None
    market_value: Decimal
    maturity_date: date | None
    reference_date: date
    source: SourceRef

    @property
    def natural_key(self) -> str:
        identity = self.isin or self.instrument_code or self.product_name
        return "|".join((self.owner, self.institution, self.account or "", identity))


@dataclass(frozen=True)
class MovementRecord:
    owner: str
    custody_direction: str
    occurred_on: date
    movement_name: str
    product_name: str
    institution: str
    instrument_code: str | None
    quantity: Decimal | None
    unit_price: Decimal | None
    operation_value: Decimal | None
    source: SourceRef


@dataclass(frozen=True)
class EventLeg:
    leg_type: LegType
    amount: Decimal
    currency: str = "BRL"
    instrument_code: str | None = None
    note: str | None = None


@dataclass(frozen=True)
class CanonicalEvent:
    owner: str
    occurred_on: date
    event_type: EventType
    institution: str
    instrument_code: str | None
    description: str
    legs: tuple[EventLeg, ...]
    requires_review: bool
    source: SourceRef


@dataclass(frozen=True)
class ReconciliationIssue:
    issue_type: str
    natural_key: str
    expected_quantity: Decimal | None
    observed_quantity: Decimal | None
    difference: Decimal | None
    severity: str
    explanation: str


@dataclass(frozen=True)
class ProjectionScenario:
    name: str
    starting_value: Decimal
    annual_nominal_return: Decimal
    annual_inflation: Decimal
    monthly_contribution: Decimal
    monthly_withdrawal: Decimal
    years: int


@dataclass(frozen=True)
class ProjectionPoint:
    year: int
    nominal_value: Decimal
    real_value: Decimal
    contributions: Decimal
    withdrawals: Decimal


@dataclass(frozen=True)
class Recommendation:
    code: str
    severity: str
    title: str
    explanation: str
    evidence: dict[str, str] = field(default_factory=dict)
    blocked_by_data_quality: bool = False
