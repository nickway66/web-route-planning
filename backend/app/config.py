import os

from dotenv import load_dotenv


load_dotenv()


class Settings:
    amap_web_service_key: str = os.getenv("AMAP_WEB_SERVICE_KEY", "").strip()
    zhipu_api_key: str = os.getenv("ZHIPU_API_KEY", "").strip()
    zhipu_api_id: str = os.getenv("ZHIPU_API_ID", "").strip()
    zhipu_model: str = os.getenv("ZHIPU_MODEL", "glm-4-flash").strip() or "glm-4-flash"
    cors_origins: list[str] = [
        item.strip()
        for item in os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
        if item.strip()
    ]


settings = Settings()
