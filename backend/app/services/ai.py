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
    "你是专业旅游路线规划AI，仅执行路线规划。必须只返回合法 JSON，不要返回 Markdown、代码块或 JSON 以外的文字。"
    "所有地点必须使用高德地图可搜索到的标准官方全称，禁止简称、俗称、别名；如果不确定地点能被高德搜索到，就不要放入 places。"
    'JSON 结构固定为：{"city":"目标城市","days":[{"day":1,"places":[{"name":"高德官方地点全称","duration":"预计游玩时间","cost":"预计消费金额","hours":"营业时间","description":"景点简要介绍"}]}]}。'
    "如果用户要求两日或多日游玩路线，则 days 内每日一条路线。地点顺序就是路线顺序。"
)


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
        if len(places) >= 2:
            days.append({"day": int(raw_day.get("day", index + 1)) if isinstance(raw_day, dict) else index + 1, "places": places})
    if not days:
        return None
    return {"city": str(data.get("city") or data.get("targetCity") or "").strip(), "days": days[:10]}


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


async def request_zhipu_reply(messages: list[dict[str, str]], api_key: str, api_id: str, model: str) -> tuple[str, dict[str, Any] | None]:
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
    plan = parse_ai_plan(reply)
    if plan:
        return visible_plan_text(plan), plan
    return reply, None
