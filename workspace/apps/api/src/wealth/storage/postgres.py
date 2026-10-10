from __future__ import annotations

import hashlib
import json
import os
from datetime import date, datetime
from decimal import Decimal
from functools import lru_cache
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import Engine, create_engine, text

from wealth.domain import CanonicalEvent, MovementRecord, PositionRecord


def _json_default(value: Any) -> str:
    if isinstance(value, (date, datetime, Decimal)):
        return str(value)
    raise TypeError(f"Tipo não serializável: {type(value)!r}")


class DatabaseStore:
    """Small PostgreSQL adapter that keeps every canonical fact tied to its source."""

    def __init__(self, database_url: str) -> None:
        self.engine: Engine = create_engine(database_url, pool_pre_ping=True)

    def _identity(self, connection: Any, owner: str) -> tuple[UUID, UUID]:
        household_id = connection.execute(
            text("SELECT id FROM households WHERE name = :name"),
            {"name": "Família Jorge e Julia"},
        ).scalar_one_or_none()
        if household_id is None:
            household_id = uuid4()
            connection.execute(
                text("INSERT INTO households (id, name) VALUES (:id, :name)"),
                {"id": household_id, "name": "Família Jorge e Julia"},
            )
        person_id = connection.execute(
            text("SELECT id FROM people WHERE household_id = :household AND name = :name"),
            {"household": household_id, "name": owner},
        ).scalar_one_or_none()
        if person_id is None:
            person_id = uuid4()
            connection.execute(
                text("INSERT INTO people (id, household_id, name) VALUES (:id, :household, :name)"),
                {"id": person_id, "household": household_id, "name": owner},
            )
        return household_id, person_id

    def _source(
        self,
        connection: Any,
        *,
        household_id: UUID,
        content: bytes,
        file_name: str,
        reference_date: date | None,
    ) -> tuple[UUID, bool]:
        digest = hashlib.sha256(content).hexdigest()
        existing = connection.execute(
            text("SELECT id FROM source_files WHERE content_sha256 = :digest"), {"digest": digest}
        ).scalar_one_or_none()
        if existing:
            return existing, True
        source_id = uuid4()
        connection.execute(
            text("""
                INSERT INTO source_files
                    (id, household_id, provider, file_name, content_sha256, reference_date, status)
                VALUES (:id, :household, 'b3', :file_name, :digest, :reference_date, 'processed')
            """),
            {
                "id": source_id,
                "household": household_id,
                "file_name": file_name,
                "digest": digest,
                "reference_date": reference_date,
            },
        )
        return source_id, False

    @staticmethod
    def _raw(
        connection: Any, source_id: UUID, records: list[PositionRecord | MovementRecord]
    ) -> None:
        for record in records:
            connection.execute(
                text("""
                    INSERT INTO raw_records (id, source_file_id, sheet_name, row_number, payload)
                    VALUES (:id, :source, :sheet, :row, CAST(:payload AS jsonb))
                """),
                {
                    "id": uuid4(),
                    "source": source_id,
                    "sheet": record.source.sheet_name,
                    "row": record.source.row_number,
                    "payload": json.dumps(
                        record.source.raw, default=_json_default, ensure_ascii=False
                    ),
                },
            )

    @staticmethod
    def _institution(connection: Any, name: str) -> UUID:
        canonical = name or "Não informado"
        institution_id = connection.execute(
            text("SELECT id FROM institutions WHERE canonical_name = :name"), {"name": canonical}
        ).scalar_one_or_none()
        if institution_id is None:
            institution_id = uuid4()
            connection.execute(
                text("INSERT INTO institutions (id, canonical_name) VALUES (:id, :name)"),
                {"id": institution_id, "name": canonical},
            )
        return institution_id

    def _account(
        self, connection: Any, person_id: UUID, institution: str, external_ref: str | None
    ) -> UUID:
        institution_id = self._institution(connection, institution)
        account_id = connection.execute(
            text("""
                SELECT id FROM accounts
                WHERE person_id = :person AND institution_id = :institution
                  AND external_account_ref IS NOT DISTINCT FROM :external_ref
            """),
            {"person": person_id, "institution": institution_id, "external_ref": external_ref},
        ).scalar_one_or_none()
        if account_id is None:
            account_id = uuid4()
            connection.execute(
                text("""
                    INSERT INTO accounts
                        (id, person_id, institution_id, external_account_ref)
                    VALUES (:id, :person, :institution, :external_ref)
                """),
                {
                    "id": account_id,
                    "person": person_id,
                    "institution": institution_id,
                    "external_ref": external_ref,
                },
            )
        return account_id

    @staticmethod
    def _instrument(connection: Any, record: PositionRecord | MovementRecord) -> UUID:
        alias = record.instrument_code or record.product_name
        instrument_id = None
        if isinstance(record, PositionRecord) and record.isin:
            instrument_id = connection.execute(
                text("SELECT id FROM instruments WHERE isin = :isin"), {"isin": record.isin}
            ).scalar_one_or_none()
        if instrument_id is None:
            instrument_id = connection.execute(
                text("""
                    SELECT instrument_id FROM instrument_aliases
                    WHERE provider = 'b3' AND alias = :alias
                """),
                {"alias": alias},
            ).scalar_one_or_none()
        if instrument_id is None:
            instrument_id = uuid4()
            asset_class = (
                record.asset_class.value if isinstance(record, PositionRecord) else "other"
            )
            connection.execute(
                text("""
                    INSERT INTO instruments
                        (id, asset_class, canonical_name, ticker, isin, issuer_name, maturity_date)
                    VALUES (:id, :asset_class, :name, :ticker, :isin, :issuer, :maturity)
                """),
                {
                    "id": instrument_id,
                    "asset_class": asset_class,
                    "name": record.product_name,
                    "ticker": record.instrument_code,
                    "isin": record.isin if isinstance(record, PositionRecord) else None,
                    "issuer": record.issuer if isinstance(record, PositionRecord) else None,
                    "maturity": record.maturity_date
                    if isinstance(record, PositionRecord)
                    else None,
                },
            )
            connection.execute(
                text("""
                    INSERT INTO instrument_aliases (id, instrument_id, provider, alias)
                    VALUES (:id, :instrument, 'b3', :alias)
                """),
                {"id": uuid4(), "instrument": instrument_id, "alias": alias},
            )
        return instrument_id

    def save_positions(
        self, content: bytes, file_name: str, positions: list[PositionRecord]
    ) -> bool:
        if not positions:
            return False
        with self.engine.begin() as connection:
            household_id, person_id = self._identity(connection, positions[0].owner)
            source_id, duplicate = self._source(
                connection,
                household_id=household_id,
                content=content,
                file_name=file_name,
                reference_date=positions[0].reference_date,
            )
            if duplicate:
                return True
            self._raw(connection, source_id, positions)
            for record in positions:
                account_id = self._account(
                    connection, person_id, record.institution, record.account
                )
                instrument_id = self._instrument(connection, record)
                connection.execute(
                    text("""
                        INSERT INTO position_snapshots
                            (id, person_id, account_id, instrument_id, source_file_id,
                             reference_date, quantity, unit_price, market_value)
                        VALUES (:id, :person, :account, :instrument, :source, :reference_date,
                                :quantity, :unit_price, :market_value)
                        ON CONFLICT (person_id, account_id, instrument_id, reference_date)
                        DO UPDATE SET quantity = EXCLUDED.quantity,
                                      unit_price = EXCLUDED.unit_price,
                                      market_value = EXCLUDED.market_value,
                                      source_file_id = EXCLUDED.source_file_id
                    """),
                    {
                        "id": uuid4(),
                        "person": person_id,
                        "account": account_id,
                        "instrument": instrument_id,
                        "source": source_id,
                        "reference_date": record.reference_date,
                        "quantity": record.quantity,
                        "unit_price": record.unit_price,
                        "market_value": record.market_value,
                    },
                )
        return False

    def save_events(
        self,
        content: bytes,
        file_name: str,
        rows: list[MovementRecord],
        events: list[CanonicalEvent],
    ) -> bool:
        if not rows:
            return False
        with self.engine.begin() as connection:
            household_id, person_id = self._identity(connection, rows[0].owner)
            source_id, duplicate = self._source(
                connection,
                household_id=household_id,
                content=content,
                file_name=file_name,
                reference_date=None,
            )
            if duplicate:
                return True
            self._raw(connection, source_id, rows)
            for row, event in zip(rows, events, strict=True):
                account_id = self._account(connection, person_id, row.institution, None)
                instrument_id = self._instrument(connection, row)
                event_id = uuid4()
                connection.execute(
                    text("""
                        INSERT INTO events
                            (id, person_id, account_id, instrument_id, source_file_id, occurred_on,
                             event_type, description, requires_review, classification_version)
                        VALUES (:id, :person, :account, :instrument, :source, :occurred_on,
                                :event_type, :description, :review, 'b3-rules-v1')
                    """),
                    {
                        "id": event_id,
                        "person": person_id,
                        "account": account_id,
                        "instrument": instrument_id,
                        "source": source_id,
                        "occurred_on": event.occurred_on,
                        "event_type": event.event_type.value,
                        "description": event.description,
                        "review": event.requires_review,
                    },
                )
                for leg in event.legs:
                    connection.execute(
                        text("""
                            INSERT INTO event_legs
                                (id, event_id, leg_type, amount, currency, note)
                            VALUES (:id, :event, :leg_type, :amount, :currency, :note)
                        """),
                        {
                            "id": uuid4(),
                            "event": event_id,
                            "leg_type": leg.leg_type.value,
                            "amount": leg.amount,
                            "currency": leg.currency,
                            "note": leg.note,
                        },
                    )
        return False


@lru_cache(maxsize=1)
def store_from_environment() -> DatabaseStore | None:
    database_url = os.getenv("DATABASE_URL")
    return DatabaseStore(database_url) if database_url else None
