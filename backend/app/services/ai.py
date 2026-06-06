import base64
import hmac
import json
import re
import time
from hashlib import sha256
from typing import Any

import httpx


ZHIPU_CHAT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions"
AI_SYSTEM_PROMPT = (
    "你是旅游助手和路线规划 AI，不要向用户透露任何关于你是什么模型，你的架构与设计等与旅行或路线规划无关的信息。"
    "始终只返回合法 JSON，不要返回 Markdown、代码块或 JSON 以外的文字。"
    'JSON 顶层固定为 {"type":"chat|travel_advice|route_plan|cancel_or_negative","reply":"给用户看的自然语言","plan":null}。'
    "只有用户明确要求具体路线、行程、方案、景点顺序或地图路线时，才返回 route_plan。"
    "普通聊天、纠错、系统行为问答返回 chat。"
    "旅游相关但信息不足以生成具体路线时返回 travel_advice。"
    "用户取消、拒绝或不想继续当前规划时返回 cancel_or_negative。"
    'route_plan 的 plan 结构为 {"city":"目标城市","days":[{"day":1,"places":[{"name":"高德地图可搜索的官方地点全称","duration":"预计游玩时间","cost":"预计消费金额","hours":"营业时间","description":"景点简要介绍"}]}]}。'
    "plan.days[].places[].name 必须是高德可搜索的正式地点名，reply 不要原样复述 plan JSON。"
)

AI_RESPONSE_TYPES = {"chat", "travel_advice", "route_plan", "cancel_or_negative"}


def _base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def build_zhipu_auth(api_key: str, api_id: str = "") -> str:
    raw_key = (api_key or "").strip()
    raw_id = (api_id or "").strip()
    if "." in raw_key:
        key_id, key_secret = raw_key.split(".", 1)
    else:
        key_id, key_secret = raw_id, raw_key
    if not key_id or not key_secret:
        raise ValueError("ZHIPU_API_KEY or ZHIPU_API_ID is not configured")
    header = {"alg": "HS256", "sign_type": "SIGN"}
    payload = {"api_key": key_id, "exp": int(time.time() * 1000) + 3600 * 1000, "timestamp": int(time.time() * 1000)}
    signing_input = f"{_base64url(json.dumps(header, separators=(',', ':')).encode())}.{_base64url(json.dumps(payload, separators=(',', ':')).encode())}"
    signature = hmac.new(key_secret.encode(), signing_input.encode(), sha256).digest()
    return f"Bearer {signing_input}.{_base64url(signature)}"


def normalize_ai_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return "".join(normalize_ai_text(item) for item in content).strip()
    if isinstance(content, dict):
        return str(content.get("text") or content.get("content") or "").strip()
    return ""


def extract_json_object(raw_text: str) -> str:
    text = str(raw_text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
    text = re.sub(r"\s*```$", "", text, flags=re.I)
    if text.startswith("{") and text.endswith("}"):
        return text
    start = text.find("{")
    end = text.rfind("}")
    return text[start : end + 1] if start >= 0 and end > start else ""


def normalize_place(place: Any) -> dict[str, str] | None:
    if isinstance(place, str):
        name = place.strip()
        return {"name": name} if name else None
    if not isinstance(place, dict):
        return None
    name = str(place.get("name") or place.get("place") or place.get("title") or "").strip()
    if not name:
        return None
    return {
        "name": name,
        "duration": str(place.get("duration") or place.get("playTime") or "").strip(),
        "cost": str(place.get("cost") or place.get("price") or "").strip(),
        "hours": str(place.get("hours") or place.get("openingHours") or "").strip(),
        "description": str(place.get("description") or place.get("intro") or place.get("note") or "").strip(),
    }


def parse_ai_plan(raw_text: str) -> dict[str, Any] | None:
    json_text = extract_json_object(raw_text)
    if not json_text:
        return None
    try:
        data = json.loads(json_text)
    except json.JSONDecodeError:
        return None
    raw_days = data.get("days") or data.get("routes") or []
    if not raw_days and isinstance(data.get("places"), list):
        raw_days = [{"day": 1, "places": data["places"]}]
    days = []
    for index, raw_day in enumerate(raw_days):
        raw_places = raw_day.get("places") if isinstance(raw_day, dict) else raw_day
        places = [place for item in (raw_places or []) if (place := normalize_place(item))]
        if places:
            days.append({"day": int(raw_day.get("day", index + 1)) if isinstance(raw_day, dict) else index + 1, "places": places})
    if not days:
        return None
    return {"city": str(data.get("city") or data.get("targetCity") or "").strip(), "days": days[:10]}


def normalize_ai_type(value: Any) -> str:
    ai_type = str(value or "chat").strip()
    return ai_type if ai_type in AI_RESPONSE_TYPES else "chat"


def normalize_ai_plan(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, str):
        return parse_ai_plan(value)
    if not isinstance(value, dict):
        return None

    raw_days = value.get("days") or value.get("routes") or []
    if not raw_days and isinstance(value.get("places"), list):
        raw_days = [{"day": 1, "places": value["places"]}]

    days = []
    total_places = 0
    for index, raw_day in enumerate(raw_days):
        raw_places = raw_day.get("places") if isinstance(raw_day, dict) else raw_day
        places = [place for item in (raw_places or []) if (place := normalize_place(item))]
        if not places:
            continue
        total_places += len(places)
        day_number = raw_day.get("day", index + 1) if isinstance(raw_day, dict) else index + 1
        try:
            day_number = int(day_number)
        except (TypeError, ValueError):
            day_number = index + 1
        days.append({"day": day_number, "places": places})

    if total_places < 2:
        return None
    return {"city": str(value.get("city") or value.get("targetCity") or "").strip(), "days": days[:10]}


def make_fallback_reply(ai_type: str, plan: dict[str, Any] | None = None) -> str:
    if ai_type == "route_plan" and plan:
        city = str(plan.get("city") or "").strip()
        return f"已为你整理好{city}路线方案，可以查看并决定是否添加到地图。"
    if ai_type == "travel_advice":
        return "我先给你一些旅游建议，确认目的地和偏好后再生成具体路线。"
    if ai_type == "cancel_or_negative":
        return "已取消路线规划意图。"
    return "我可以继续帮你处理旅游建议或路线规划问题。"


def parse_ai_envelope(raw_text: str) -> dict[str, Any]:
    text = str(raw_text or "").strip()
    json_text = extract_json_object(text)
    if not json_text:
        reply = text or make_fallback_reply("chat")
        return {"type": "chat", "reply": reply, "plan": None, "parsedPlan": None}

    try:
        data = json.loads(json_text)
    except json.JSONDecodeError:
        reply = text or make_fallback_reply("chat")
        return {"type": "chat", "reply": reply, "plan": None, "parsedPlan": None}

    if not isinstance(data, dict):
        reply = text or make_fallback_reply("chat")
        return {"type": "chat", "reply": reply, "plan": None, "parsedPlan": None}

    legacy_plan = normalize_ai_plan(data)
    if "type" not in data and legacy_plan:
        reply = make_fallback_reply("route_plan", legacy_plan)
        return {"type": "route_plan", "reply": reply, "plan": legacy_plan, "parsedPlan": legacy_plan}

    ai_type = normalize_ai_type(data.get("type"))
    plan = normalize_ai_plan(data.get("plan"))
    if ai_type == "route_plan" and not plan:
        ai_type = "travel_advice"
    if ai_type != "route_plan":
        plan = None

    reply = str(data.get("reply") or "").strip() or make_fallback_reply(ai_type, plan)
    return {"type": ai_type, "reply": reply, "plan": plan, "parsedPlan": plan}


def visible_plan_text(plan: dict[str, Any]) -> str:
    chunks = []
    for day in plan["days"]:
        lines = [f"第{day.get('day', 1)}天"] if len(plan["days"]) > 1 else []
        for place in day["places"]:
            place_lines = [f'"{place["name"]}"']
            if place.get("duration"):
                place_lines.append(f"预计游玩{place['duration']}")
            if place.get("cost"):
                place_lines.append(place["cost"])
            if place.get("hours"):
                place_lines.append(f"营业时间：{place['hours']}")
            if place.get("description"):
                place_lines.append(place["description"])
            lines.append("\n".join(place_lines))
        chunks.append("\n\n".join(lines))
    return "\n\n".join(chunks)


async def request_zhipu_reply(messages: list[dict[str, str]], api_key: str, api_id: str, model: str) -> dict[str, Any]:
    final_messages = [{"role": "system", "content": AI_SYSTEM_PROMPT}, *messages[-20:]]
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.post(
            ZHIPU_CHAT_ENDPOINT,
            headers={"Content-Type": "application/json", "Authorization": build_zhipu_auth(api_key, api_id)},
            json={"model": model, "messages": final_messages},
        )
        response.raise_for_status()
        data = response.json()
    reply = normalize_ai_text(data.get("choices", [{}])[0].get("message", {}).get("content"))
    if not reply:
        raise RuntimeError("Zhipu returned an empty reply")
    return parse_ai_envelope(reply)
