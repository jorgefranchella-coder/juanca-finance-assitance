from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from wealth.domain import (
    CanonicalEvent,
    EventLeg,
    EventType,
    LegType,
    MovementRecord,
    PositionRecord,
    ReconciliationIssue,
)


def _signed_quantity(record: MovementRecord) -> Decimal:
    quantity = record.quantity or Decimal("0")
    return quantity if record.custody_direction == "credito" else -quantity


def normalize_movement(record: MovementRecord) -> CanonicalEvent:
    name = record.movement_name.upper()
    value = record.operation_value or Decimal("0")
    quantity = record.quantity or Decimal("0")
    direction_in = record.custody_direction == "credito"
    event_type = EventType.UNKNOWN
    legs: list[EventLeg] = []
    review = False

    if "TRANSFERÊNCIA" in name:
        event_type = EventType.TRANSFER_IN if direction_in else EventType.TRANSFER_OUT
        legs.append(
            EventLeg(
                LegType.ASSET_QUANTITY,
                _signed_quantity(record),
                instrument_code=record.instrument_code,
            )
        )
    elif "VENCIMENTO/RESGATE" in name:
        event_type = EventType.MATURITY
        legs.extend(
            (
                EventLeg(LegType.ASSET_QUANTITY, -quantity, instrument_code=record.instrument_code),
                EventLeg(LegType.PRINCIPAL_RETURN, value, note="Principal informado pela B3"),
                EventLeg(LegType.CASH, value),
            )
        )
    elif "RESGATE ANTECIPADO" in name:
        event_type = EventType.EARLY_REDEMPTION
        legs.extend(
            (
                EventLeg(LegType.ASSET_QUANTITY, -quantity, instrument_code=record.instrument_code),
                EventLeg(LegType.PRINCIPAL_RETURN, value),
                EventLeg(LegType.CASH, value),
            )
        )
    elif "AMORTIZA" in name:
        event_type = EventType.AMORTIZATION
        legs.extend((EventLeg(LegType.PRINCIPAL_RETURN, value), EventLeg(LegType.CASH, value)))
    elif "JUROS SOBRE CAPITAL" in name:
        event_type = EventType.JCP
        legs.extend((EventLeg(LegType.INCOME, value), EventLeg(LegType.CASH, value)))
    elif "DIVIDENDO" in name:
        event_type = EventType.DIVIDEND
        legs.extend((EventLeg(LegType.INCOME, value), EventLeg(LegType.CASH, value)))
    elif "JUROS" in name:
        event_type = EventType.INTEREST
        legs.extend((EventLeg(LegType.INCOME, value), EventLeg(LegType.CASH, value)))
    elif "RENDIMENTO" in name or name == "RENDIMENTO":
        event_type = EventType.INCOME
        legs.extend((EventLeg(LegType.INCOME, value), EventLeg(LegType.CASH, value)))
    elif "COMPRA" in name or "VENDA" in name:
        event_type = EventType.BUY if direction_in else EventType.SELL
        legs.extend(
            (
                EventLeg(
                    LegType.ASSET_QUANTITY,
                    _signed_quantity(record),
                    instrument_code=record.instrument_code,
                ),
                EventLeg(LegType.CASH, -value if direction_in else value),
            )
        )
    elif "ATUALIZAÇÃO" in name:
        event_type = EventType.CORPORATE_ACTION
        review = True
    else:
        review = True

    return CanonicalEvent(
        owner=record.owner,
        occurred_on=record.occurred_on,
        event_type=event_type,
        institution=record.institution,
        instrument_code=record.instrument_code,
        description=record.movement_name,
        legs=tuple(legs),
        requires_review=review,
        source=record.source,
    )


def reconcile_quantities(
    previous: list[PositionRecord],
    current: list[PositionRecord],
    events: list[CanonicalEvent],
    *,
    tolerance: Decimal = Decimal("0.000001"),
) -> list[ReconciliationIssue]:
    before: dict[tuple[str, str, str], Decimal] = defaultdict(Decimal)
    after: dict[tuple[str, str, str], Decimal] = defaultdict(Decimal)
    changes: dict[tuple[str, str, str], Decimal] = defaultdict(Decimal)

    for position in previous:
        if position.instrument_code and position.quantity is not None:
            before[(position.owner, position.institution, position.instrument_code)] += (
                position.quantity
            )
    for position in current:
        if position.instrument_code and position.quantity is not None:
            after[(position.owner, position.institution, position.instrument_code)] += (
                position.quantity
            )
    for event in events:
        if not event.instrument_code:
            continue
        for leg in event.legs:
            if leg.leg_type == LegType.ASSET_QUANTITY:
                changes[(event.owner, event.institution, event.instrument_code)] += leg.amount

    issues: list[ReconciliationIssue] = []
    for key in sorted(set(before) | set(after) | set(changes)):
        expected = before[key] + changes[key]
        observed = after[key]
        difference = observed - expected
        if abs(difference) > tolerance:
            issues.append(
                ReconciliationIssue(
                    issue_type="quantity_mismatch",
                    natural_key="|".join(key),
                    expected_quantity=expected,
                    observed_quantity=observed,
                    difference=difference,
                    severity="high" if observed == 0 or expected == 0 else "medium",
                    explanation="A posição atual não fecha com a posição anterior e os eventos normalizados.",
                )
            )
    return issues
