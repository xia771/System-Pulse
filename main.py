from __future__ import annotations

import asyncio
import csv
import io
import sqlite3
import time
from collections.abc import Mapping
from contextlib import asynccontextmanager, suppress
from heapq import nlargest
from pathlib import Path

import psutil
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

REFRESH_INTERVAL_SECONDS = 1.0
PROCESS_LIMIT = 5
CPU_CORES = max(psutil.cpu_count(logical=True) or 1, 1)
IDLE_PROCESS_NAMES = {"System Idle Process", "Idle"}
HISTORY_RETENTION_HOURS = 24
HISTORY_PRUNE_INTERVAL = 120
DEFAULT_HISTORY_MINUTES = 30
MAX_HISTORY_LIMIT = 10000

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = BASE_DIR / "metrics_history.db"

MetricScalar = float | int
ProcessRow = dict[str, MetricScalar | str]
MetricsPayload = dict[str, MetricScalar | list[ProcessRow]]

latest_metrics: MetricsPayload | None = None
history_write_count = 0
sampler_task: asyncio.Task[None] | None = None


def to_int(value: object, fallback: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            return fallback
    return fallback


def to_float(value: object, fallback: float = 0.0) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return fallback
    return fallback


def init_history_db() -> None:
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS metrics_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                cpu_percent REAL NOT NULL,
                mem_percent REAL NOT NULL,
                mem_used_gb REAL NOT NULL,
                mem_total_gb REAL NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_metrics_history_ts
            ON metrics_history (ts)
            """
        )


def store_metrics_history(metrics: Mapping[str, object]) -> None:
    global history_write_count

    history_write_count += 1
    should_prune = history_write_count % HISTORY_PRUNE_INTERVAL == 0
    cutoff_ts = int(time.time()) - HISTORY_RETENTION_HOURS * 3600

    with sqlite3.connect(DB_PATH) as connection:
        connection.execute(
            """
            INSERT INTO metrics_history (ts, cpu_percent, mem_percent, mem_used_gb, mem_total_gb)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                to_int(metrics.get("ts"), int(time.time())),
                to_float(metrics.get("cpu_percent")),
                to_float(metrics.get("mem_percent")),
                to_float(metrics.get("mem_used_gb")),
                to_float(metrics.get("mem_total_gb")),
            ),
        )
        if should_prune:
            connection.execute(
                "DELETE FROM metrics_history WHERE ts < ?",
                (cutoff_ts,),
            )


def fetch_history_rows(minutes: int, limit: int) -> list[dict[str, float | int]]:
    since_ts = int(time.time()) - minutes * 60
    with sqlite3.connect(DB_PATH) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            """
            SELECT ts, cpu_percent, mem_percent, mem_used_gb, mem_total_gb
            FROM metrics_history
            WHERE ts >= ?
            ORDER BY ts DESC
            LIMIT ?
            """,
            (since_ts, limit),
        ).fetchall()

    items_desc = [
        {
            "ts": int(row["ts"]),
            "cpu_percent": float(row["cpu_percent"]),
            "mem_percent": float(row["mem_percent"]),
            "mem_used_gb": float(row["mem_used_gb"]),
            "mem_total_gb": float(row["mem_total_gb"]),
        }
        for row in rows
    ]
    items_desc.reverse()
    return items_desc


def history_rows_to_csv(rows: list[dict[str, float | int]]) -> str:
    output = io.StringIO()
    output.write("\ufeff")
    writer = csv.writer(output)
    writer.writerow(["timestamp", "cpu_percent", "mem_percent", "mem_used_gb", "mem_total_gb"])
    for row in rows:
        writer.writerow(
            [
                int(row["ts"]),
                float(row["cpu_percent"]),
                float(row["mem_percent"]),
                float(row["mem_used_gb"]),
                float(row["mem_total_gb"]),
            ]
        )
    return output.getvalue()


def prime_process_counters() -> None:
    for process in psutil.process_iter():
        try:
            process.cpu_percent(interval=None)
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue


def collect_top_processes(
    limit: int = PROCESS_LIMIT,
) -> tuple[list[ProcessRow], list[ProcessRow]]:
    process_rows: list[ProcessRow] = []
    for process in psutil.process_iter(["pid", "name", "memory_percent", "memory_info"]):
        try:
            info = process.info
            memory_info = info.get("memory_info")
            memory_mb = memory_info.rss / (1024**2) if memory_info else 0.0
            process_name = str(info.get("name") or "Unknown")
            raw_cpu_percent = float(process.cpu_percent(interval=None))
            normalized_cpu_percent = max(0.0, min(raw_cpu_percent / CPU_CORES, 100.0))
            process_rows.append(
                {
                    "pid": int(info.get("pid") or process.pid),
                    "name": process_name,
                    "cpu_percent": round(normalized_cpu_percent, 1),
                    "memory_percent": round(float(info.get("memory_percent") or 0.0), 1),
                    "memory_mb": round(memory_mb, 1),
                }
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue

    cpu_rank_candidates = [
        item
        for item in process_rows
        if int(item["pid"]) > 0 and str(item["name"]) not in IDLE_PROCESS_NAMES
    ]
    top_cpu = nlargest(limit, cpu_rank_candidates, key=lambda item: float(item["cpu_percent"]))
    top_memory = nlargest(
        limit,
        [item for item in process_rows if int(item["pid"]) > 0],
        key=lambda item: float(item["memory_percent"]),
    )
    return top_cpu, top_memory


def collect_metrics() -> MetricsPayload:
    memory = psutil.virtual_memory()
    top_cpu, top_memory = collect_top_processes()
    return {
        "ts": int(time.time()),
        "cpu_percent": round(psutil.cpu_percent(interval=None), 1),
        "mem_percent": round(memory.percent, 1),
        "mem_used_gb": round(memory.used / (1024**3), 2),
        "mem_total_gb": round(memory.total / (1024**3), 2),
        "top_cpu_processes": top_cpu,
        "top_memory_processes": top_memory,
    }


async def metrics_sampler() -> None:
    global latest_metrics
    while True:
        metrics = collect_metrics()
        latest_metrics = metrics
        store_metrics_history(metrics)
        await asyncio.sleep(REFRESH_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global latest_metrics, sampler_task

    init_history_db()
    psutil.cpu_percent(interval=None)
    prime_process_counters()

    initial_metrics = collect_metrics()
    latest_metrics = initial_metrics
    store_metrics_history(initial_metrics)
    sampler_task = asyncio.create_task(metrics_sampler())

    try:
        yield
    finally:
        if sampler_task is not None:
            sampler_task.cancel()
            with suppress(asyncio.CancelledError):
                await sampler_task
            sampler_task = None


app = FastAPI(title="System Pulse", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/metrics")
async def metrics_snapshot() -> MetricsPayload:
    if latest_metrics is None:
        return collect_metrics()
    return latest_metrics


@app.get("/api/history")
async def metrics_history(
    minutes: int = Query(DEFAULT_HISTORY_MINUTES, ge=1, le=HISTORY_RETENTION_HOURS * 60),
    limit: int = Query(3600, ge=60, le=MAX_HISTORY_LIMIT),
) -> dict[str, int | list[dict[str, float | int]]]:
    items = fetch_history_rows(minutes=minutes, limit=limit)
    return {
        "minutes": minutes,
        "count": len(items),
        "items": items,
    }


@app.get("/api/history/export")
async def metrics_history_export(
    minutes: int = Query(DEFAULT_HISTORY_MINUTES, ge=1, le=HISTORY_RETENTION_HOURS * 60),
    limit: int = Query(3600, ge=60, le=MAX_HISTORY_LIMIT),
) -> PlainTextResponse:
    items = fetch_history_rows(minutes=minutes, limit=limit)
    payload = history_rows_to_csv(items)
    filename = f"metrics-history-{minutes}m-{int(time.time())}.csv"
    return PlainTextResponse(
        payload,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.websocket("/ws/metrics")
async def metrics_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            payload = latest_metrics if latest_metrics is not None else collect_metrics()
            await websocket.send_json(payload)
            await asyncio.sleep(REFRESH_INTERVAL_SECONDS)
    except WebSocketDisconnect:
        return
