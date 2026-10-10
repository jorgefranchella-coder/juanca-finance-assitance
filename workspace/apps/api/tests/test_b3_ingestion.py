from datetime import date
from decimal import Decimal
from io import BytesIO

from openpyxl import Workbook

from wealth.domain import EventType, LegType
from wealth.ingestion import parse_movement_workbook, parse_position_workbook
from wealth.reconciliation import normalize_movement


def workbook_bytes(sheet_name: str, rows: list[list[object]]) -> BytesIO:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_name
    for row in rows:
        sheet.append(row)
    output = BytesIO()
    workbook.save(output)
    output.seek(0)
    return output


def test_parse_positions_ignores_b3_footer() -> None:
    source = workbook_bytes(
        "Acoes",
        [
            [
                "Produto",
                "Instituição",
                "Conta",
                "Código de Negociação",
                "Quantidade",
                "Preço de Fechamento",
                "Valor Atualizado",
            ],
            ["ITUB4 - ITAU UNIBANCO", "ITAU CV S/A", "716910", "ITUB4", 339, 38.31, 12987.09],
            [67, None, None, None, None, None, None],
            [67, 67, 67, 67, 67, "Total", 12987.09],
        ],
    )
    records = parse_position_workbook(source, owner="Jorge", reference_date=date(2026, 8, 15))
    assert len(records) == 1
    assert records[0].instrument_code == "ITUB4"
    assert records[0].quantity == Decimal("339")
    assert records[0].market_value == Decimal("12987.09")


def test_maturity_has_separate_asset_and_cash_legs() -> None:
    source = workbook_bytes(
        "Movimentação",
        [
            [
                "Entrada/Saída",
                "Data",
                "Movimentação",
                "Produto",
                "Instituição",
                "Quantidade",
                "Preço unitário",
                "Valor da Operação",
            ],
            [
                "Debito",
                "10/08/2026",
                "VENCIMENTO/RESGATE SALDO EM CONTA",
                "CDB - CDB3208HBNU - BANCO BS2 S.A.",
                "ITAU CV S/A",
                2,
                1000,
                2000,
            ],
        ],
    )
    movement = parse_movement_workbook(source, owner="Jorge")[0]
    event = normalize_movement(movement)
    assert event.event_type == EventType.MATURITY
    assert any(
        leg.leg_type == LegType.ASSET_QUANTITY and leg.amount == Decimal("-2") for leg in event.legs
    )
    assert any(leg.leg_type == LegType.CASH and leg.amount == Decimal("2000") for leg in event.legs)


def test_transfer_changes_custody_without_creating_cash() -> None:
    source = workbook_bytes(
        "Movimentação",
        [
            [
                "Entrada/Saída",
                "Data",
                "Movimentação",
                "Produto",
                "Instituição",
                "Quantidade",
                "Preço unitário",
                "Valor da Operação",
            ],
            [
                "Credito",
                "17/07/2026",
                "Transferência - Liquidação",
                "BOAC34 - BANK OF AMERICA",
                "ITAU CV S/A",
                100,
                78.25,
                7825,
            ],
        ],
    )
    event = normalize_movement(parse_movement_workbook(source, owner="Jorge")[0])
    assert event.event_type == EventType.TRANSFER_IN
    assert len(event.legs) == 1
    assert event.legs[0].leg_type == LegType.ASSET_QUANTITY
    assert event.legs[0].amount == Decimal("100")
