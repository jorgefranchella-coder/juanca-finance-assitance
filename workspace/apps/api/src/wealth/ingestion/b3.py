from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import BinaryIO

from openpyxl import load_workbook

from wealth.domain import AssetClass, MovementRecord, PositionRecord, SourceRef

POSITION_SHEETS = {
    "Acoes": AssetClass.EQUITY,
    "BDR": AssetClass.BDR,
    "ETF": AssetClass.ETF,
    "Fundo de Investimento": AssetClass.FUND,
    "Renda Fixa": AssetClass.FIXED_INCOME,
    "Tesouro Direto": AssetClass.TREASURY,
}


def _decimal(value: object) -> Decimal | None:
    if value in (None, "", "-"):
        return None
    try:
        return (
            Decimal(str(value).replace("R$", "").strip().replace(".", "").replace(",", "."))
            if isinstance(value, str)
            else Decimal(str(value))
        )
    except InvalidOperation:
        return None


def _date(value: object) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value not in ("", "-"):
        for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
            try:
                return datetime.strptime(value.strip(), fmt).date()
            except ValueError:
                pass
    return None


def _clean(value: object) -> str:
    return " ".join(str(value or "").split())


def _is_export_footer(row: tuple[object, ...]) -> bool:
    values = [value for value in row if value not in (None, "")]
    # The B3 exporter appends sentinel rows whose first populated cell is 67.
    # Some of those rows also carry the portfolio total, so checking every cell
    # would accidentally import the total as an instrument.
    return not values or values[0] in (67, "67") or all(value == "Total" for value in values)


def _instrument_code(product: str, explicit: object = None) -> str | None:
    if explicit not in (None, "", "-"):
        return _clean(explicit).split(" - ")[0]
    parts = [part.strip() for part in product.split(" - ")]
    if len(parts) >= 2 and re.fullmatch(r"[A-Z0-9]{4,30}", parts[1]):
        return parts[1]
    ticker = parts[0] if parts else ""
    return ticker if re.fullmatch(r"[A-Z0-9]{4,12}", ticker) else None


def _open(source: str | Path | BinaryIO):
    if hasattr(source, "seek"):
        source.seek(0)
    return load_workbook(source, read_only=True, data_only=True)


def parse_position_workbook(
    source: str | Path | BinaryIO,
    *,
    owner: str,
    reference_date: date,
    file_name: str | None = None,
) -> list[PositionRecord]:
    workbook = _open(source)
    imported_at = datetime.now().astimezone()
    result: list[PositionRecord] = []
    source_name = file_name or getattr(source, "name", "b3-position.xlsx")

    for sheet_name, asset_class in POSITION_SHEETS.items():
        if sheet_name not in workbook.sheetnames:
            continue
        sheet = workbook[sheet_name]
        # B3 currently exports an incorrect worksheet dimension (A1) even when
        # the XML contains hundreds of cells. Read-only openpyxl trusts that
        # metadata unless dimensions are reset explicitly.
        sheet.reset_dimensions()
        rows = sheet.iter_rows(values_only=True)
        headers = [_clean(value) for value in next(rows)]
        for row_number, row in enumerate(rows, start=2):
            if _is_export_footer(row):
                continue
            raw = {headers[index]: row[index] for index in range(min(len(headers), len(row)))}
            product = _clean(raw.get("Produto"))
            if not product:
                continue
            value = (
                _decimal(raw.get("Valor Atualizado CURVA"))
                or _decimal(raw.get("Valor Atualizado MTM"))
                or _decimal(raw.get("Valor Atualizado FECHAMENTO"))
                or _decimal(raw.get("Valor Atualizado"))
            )
            if value is None:
                continue
            explicit_code = (
                raw.get("Código") or raw.get("Código de Negociação") or raw.get("Código ISIN")
            )
            source_ref = SourceRef(source_name, sheet_name, row_number, imported_at, raw)
            result.append(
                PositionRecord(
                    owner=owner,
                    asset_class=asset_class,
                    product_name=product,
                    institution=_clean(raw.get("Instituição")),
                    account=_clean(raw.get("Conta")) or None,
                    instrument_code=_instrument_code(product, explicit_code),
                    isin=_clean(raw.get("Código ISIN / Distribuição")).split(" - ")[0] or None,
                    issuer=_clean(raw.get("Emissor")) or None,
                    quantity=_decimal(raw.get("Quantidade Disponível"))
                    or _decimal(raw.get("Quantidade")),
                    unit_price=(
                        _decimal(raw.get("Preço Atualizado CURVA"))
                        or _decimal(raw.get("Preço Atualizado MTM"))
                        or _decimal(raw.get("Preço Atualizado FECHAMENTO"))
                        or _decimal(raw.get("Preço de Fechamento"))
                    ),
                    market_value=value,
                    maturity_date=_date(raw.get("Vencimento")),
                    reference_date=reference_date,
                    source=source_ref,
                )
            )
    return result


def parse_movement_workbook(
    source: str | Path | BinaryIO,
    *,
    owner: str,
    file_name: str | None = None,
) -> list[MovementRecord]:
    workbook = _open(source)
    if "Movimentação" not in workbook.sheetnames:
        raise ValueError("Aba 'Movimentação' não encontrada no arquivo B3")
    sheet = workbook["Movimentação"]
    sheet.reset_dimensions()
    rows = sheet.iter_rows(values_only=True)
    headers = [_clean(value) for value in next(rows)]
    imported_at = datetime.now().astimezone()
    source_name = file_name or getattr(source, "name", "b3-movements.xlsx")
    result: list[MovementRecord] = []

    for row_number, row in enumerate(rows, start=2):
        if _is_export_footer(row):
            continue
        raw = {headers[index]: row[index] for index in range(min(len(headers), len(row)))}
        occurred_on = _date(raw.get("Data"))
        product = _clean(raw.get("Produto"))
        if not occurred_on or not product:
            continue
        result.append(
            MovementRecord(
                owner=owner,
                custody_direction=_clean(raw.get("Entrada/Saída")).lower(),
                occurred_on=occurred_on,
                movement_name=_clean(raw.get("Movimentação")),
                product_name=product,
                institution=_clean(raw.get("Instituição")),
                instrument_code=_instrument_code(product),
                quantity=_decimal(raw.get("Quantidade")),
                unit_price=_decimal(raw.get("Preço unitário")),
                operation_value=_decimal(raw.get("Valor da Operação")),
                source=SourceRef(source_name, "Movimentação", row_number, imported_at, raw),
            )
        )
    return result
