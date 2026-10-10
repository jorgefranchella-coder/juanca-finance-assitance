from __future__ import annotations

from datetime import date
from decimal import Decimal
from io import BytesIO

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from wealth.domain import ProjectionScenario
from wealth.ingestion import parse_movement_workbook, parse_position_workbook
from wealth.projections import project_scenario
from wealth.reconciliation import normalize_movement
from wealth.storage import store_from_environment

app = FastAPI(
    title="Patrimônio API",
    version="0.1.0",
    description="Livro patrimonial, reconciliação, projeções e recomendações auditáveis.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ProjectionRequest(BaseModel):
    name: str = "Base"
    starting_value: Decimal = Field(gt=0)
    annual_nominal_return: Decimal = Field(gt=-1, lt=3)
    annual_inflation: Decimal = Field(gt=-1, lt=1)
    monthly_contribution: Decimal = Decimal("0")
    monthly_withdrawal: Decimal = Decimal("0")
    years: int = Field(ge=1, le=80)
    start_year: int = Field(default_factory=lambda: date.today().year)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/imports/b3/positions")
async def import_positions(
    file: UploadFile = File(...),
    owner: str = Form(...),
    reference_date: date = Form(...),
) -> dict[str, object]:
    content = await file.read()
    try:
        positions = parse_position_workbook(
            BytesIO(content),
            owner=owner,
            reference_date=reference_date,
            file_name=file.filename,
        )
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    store = store_from_environment()
    duplicate = (
        store.save_positions(content, file.filename or "posicao-b3.xlsx", positions)
        if store
        else False
    )
    return {
        "file": file.filename,
        "owner": owner,
        "records": len(positions),
        "market_value": str(sum((item.market_value for item in positions), Decimal("0"))),
        "classes": sorted({item.asset_class.value for item in positions}),
        "persisted": store is not None,
        "duplicate": duplicate,
    }


@app.post("/v1/imports/b3/movements")
async def import_movements(
    file: UploadFile = File(...), owner: str = Form(...)
) -> dict[str, object]:
    content = await file.read()
    try:
        rows = parse_movement_workbook(BytesIO(content), owner=owner, file_name=file.filename)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    events = [normalize_movement(row) for row in rows]
    store = store_from_environment()
    duplicate = (
        store.save_events(content, file.filename or "movimentacao-b3.xlsx", rows, events)
        if store
        else False
    )
    return {
        "file": file.filename,
        "owner": owner,
        "records": len(rows),
        "review_required": sum(event.requires_review for event in events),
        "persisted": store is not None,
        "duplicate": duplicate,
        "event_types": {
            event_type: sum(event.event_type.value == event_type for event in events)
            for event_type in sorted({event.event_type.value for event in events})
        },
    }


@app.post("/v1/projections")
def projection(request: ProjectionRequest) -> dict[str, object]:
    scenario = ProjectionScenario(
        name=request.name,
        starting_value=request.starting_value,
        annual_nominal_return=request.annual_nominal_return,
        annual_inflation=request.annual_inflation,
        monthly_contribution=request.monthly_contribution,
        monthly_withdrawal=request.monthly_withdrawal,
        years=request.years,
    )
    return {
        "scenario": request.name,
        "points": [
            {
                "year": point.year,
                "nominal_value": str(point.nominal_value),
                "real_value": str(point.real_value),
                "contributions": str(point.contributions),
                "withdrawals": str(point.withdrawals),
            }
            for point in project_scenario(scenario, start_year=request.start_year)
        ],
    }
