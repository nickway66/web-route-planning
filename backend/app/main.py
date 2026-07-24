from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import settings
from .schemas import AIBuildRequest, AIChatRequest, AIChatResponse, ExportRequest, PlanRouteRequest, PlanRouteResponse
from .services.ai import request_zhipu_reply
from .services.amap import AMapClient
from .services.exports import create_gpx, create_json
from .services.routes import build_ai_layers, plan_route
from .routers.auth import router as auth_router
from .routers.workspace import router as workspace_router
from .workspace_schemas import MAX_BODY_BYTES


app = FastAPI(title="WEBMAP_VS Backend")


class WorkspaceBodyLimitMiddleware:
    """Reject oversized workspace requests before Starlette aggregates their body."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if (
            scope["type"] != "http"
            or (path != "/api/workspace" and not path.startswith("/api/workspace/"))
            or scope["method"] not in {"POST", "PUT"}
        ):
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        content_length = headers.get(b"content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_BODY_BYTES:
                    await self._send_too_large(send)
                    return
            except ValueError:
                pass

        received_bytes = 0
        exceeded = False
        rejection_sent = False

        async def limited_receive() -> Message:
            nonlocal exceeded, received_bytes
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > MAX_BODY_BYTES:
                    exceeded = True
                    return {"type": "http.disconnect"}
            return message

        async def limited_send(message: Message) -> None:
            nonlocal rejection_sent
            if not exceeded:
                await send(message)
                return
            if not rejection_sent and message["type"] == "http.response.start":
                rejection_sent = True
                await self._send_too_large(send)

        await self.app(scope, limited_receive, limited_send)
        if exceeded and not rejection_sent:
            await self._send_too_large(send)

    @staticmethod
    async def _send_too_large(send: Send) -> None:
        body = b'{"detail":"Workspace exceeds 5 MiB"}'
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(WorkspaceBodyLimitMiddleware)

app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(workspace_router, prefix="/api/workspace", tags=["workspace"])


def amap_client() -> AMapClient:
    try:
        return AMapClient(settings.amap_web_service_key)
    except ValueError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/ai/chat", response_model=AIChatResponse)
async def ai_chat(payload: AIChatRequest) -> dict:
    try:
        return await request_zhipu_reply(
            [message.model_dump() for message in payload.messages],
            settings.zhipu_api_key,
            settings.zhipu_api_id,
            settings.zhipu_model,
        )
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.get("/api/pois/search")
async def poi_search(keyword: str = Query(..., min_length=1), preferred_city: str = "", use_map_city: bool = False) -> dict:
    try:
        pois = await amap_client().search_poi(keyword, preferred_city)
        return {"pois": pois, "fallbackUsed": False, "searchCity": preferred_city}
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.get("/api/pois/suggest")
async def poi_suggest(keyword: str = Query(..., min_length=1), preferred_city: str = "") -> dict:
    try:
        return {"suggestions": await amap_client().suggest_poi(keyword, preferred_city)}
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/routes/plan", response_model=PlanRouteResponse)
async def route_plan(payload: PlanRouteRequest) -> dict:
    try:
        return await plan_route(
            amap_client(),
            [point.model_dump() for point in payload.points],
            payload.segmentModes,
            payload.transitCity,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/routes/ai-build")
async def route_ai_build(payload: AIBuildRequest) -> dict:
    day_plans = payload.dayPlans or ([payload.placeNames] if payload.placeNames else [])
    if not day_plans:
        raise HTTPException(status_code=422, detail="dayPlans or placeNames is required")
    try:
        return await build_ai_layers(amap_client(), day_plans, payload.preferredCity, payload.existingColors)
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/exports/json")
async def export_json(payload: ExportRequest) -> Response:
    return Response(create_json(payload.layers), media_type="application/json")


@app.post("/api/exports/gpx")
async def export_gpx(payload: ExportRequest) -> Response:
    return Response(create_gpx(payload.layers), media_type="application/gpx+xml")
