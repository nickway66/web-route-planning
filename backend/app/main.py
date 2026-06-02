from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .schemas import AIBuildRequest, AIChatRequest, AIChatResponse, ExportRequest, PlanRouteRequest, PlanRouteResponse
from .services.ai import request_zhipu_reply
from .services.amap import AMapClient
from .services.exports import create_gpx, create_json
from .services.routes import build_ai_layers, plan_route


app = FastAPI(title="WEBMAP_VS Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
        reply, parsed_plan = await request_zhipu_reply(
            [message.model_dump() for message in payload.messages],
            settings.zhipu_api_key,
            settings.zhipu_api_id,
            settings.zhipu_model,
        )
        return {"reply": reply, "parsedPlan": parsed_plan}
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
