# AI Route Chat Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show detailed route places in AI chat and make follow-up route revisions return addable map routes.

**Architecture:** Backend owns semantic route normalization: parse model output, generate detailed natural-language route replies from `plan`, and detect route-revision follow-ups from conversation context. Frontend owns display fallback and map-action metadata: render detailed route text from `plan` when backend reply is too short, while preserving route buttons and JSON sanitization.

**Tech Stack:** FastAPI backend Python service in `backend/app/services/ai.py`; pytest tests in `backend/tests/test_services.py`; vanilla frontend in `src/main.js`; Vite production build.

---

### Task 1: Backend Route Detail And Follow-Up Semantics

**Files:**
- Modify: `backend/app/services/ai.py`
- Modify: `backend/tests/test_services.py`

- [ ] **Step 1: Add failing tests**

Add tests that assert:
- `parse_ai_envelope()` returns a detailed `reply` for `route_plan` containing each place name and available `duration`, `cost`, `hours`, and `description`.
- `request_zhipu_reply()` retries when the latest user message is a follow-up such as `我想去桔钓沙` and recent history contains a route planning context.

- [ ] **Step 2: Run backend tests and verify failure**

Run:

```powershell
$env:PYTHONPATH='E:\WEBMAP_VS'; pytest E:\WEBMAP_VS\backend\tests\test_services.py
```

Expected: the new tests fail before implementation.

- [ ] **Step 3: Implement backend route text generation**

Add a helper that formats route plans as natural language:

```text
为您规划了一条深圳一日游路线：

第1天
1. 桔钓沙
游玩时长：2小时
费用：免费
营业时间：全天开放
简介：适合看海和拍照。
```

Use this helper whenever `ai_type == "route_plan"` and `plan` is valid, unless the model reply already includes every route place name and at least one detail field. The final reply must not start with `{` or ``` and must never include serialized JSON.

- [ ] **Step 4: Implement context-aware follow-up route intent**

Add helpers to inspect recent messages. Treat latest messages like `我想去桔钓沙`, `加上世界之窗`, `换成亲子路线`, `不要太远`, or `第一站去桔钓沙` as route revision requests when recent history contains a route request, route action, or assistant route plan.

When route context exists and the first model result is not `route_plan`, retry once with the strict route prompt.

- [ ] **Step 5: Run backend tests and verify pass**

Run:

```powershell
$env:PYTHONPATH='E:\WEBMAP_VS'; pytest E:\WEBMAP_VS\backend\tests\test_services.py
```

Expected: all backend tests pass.

### Task 2: Frontend Detailed Route Display Fallback

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Add or update route reply builder**

Update the existing frontend natural-language plan builder so it emits detailed route text using `plan.days[].places[].name`, `duration`, `cost`, `hours`, and `description`, not just place names.

- [ ] **Step 2: Use plan text for route responses**

In `normalizeAIChatResponse()` and/or `submitAIChat()`, when `response.type === "route_plan"` and `plan` exists, ensure the displayed assistant content includes detailed route places. If backend `reply` is detailed, use it. If it is short or lacks place names, replace or append the frontend-generated detailed text.

- [ ] **Step 3: Preserve route buttons and metadata**

Keep `routePlaces`, `routeDayPlans`, `routeTargetCity`, and `routeActionStatus: "pending"` unchanged for valid route plans. Do not show JSON in the chat bubble.

- [ ] **Step 4: Build**

Run:

```powershell
& 'C:\Users\wade\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' .\node_modules\vite\bin\vite.js build
```

Expected: Vite build succeeds.

### Task 3: Integration Verification

**Files:**
- No intended source edits unless verification reveals a bug.

- [ ] **Step 1: Restart services**

Restart backend on `127.0.0.1:8000` and frontend static service on `127.0.0.1:5176`.

- [ ] **Step 2: Verify first-turn route**

In the browser, send `生成一条深圳一日游路线`. Expected: assistant bubble lists concrete route places with details and shows add-to-map buttons.

- [ ] **Step 3: Verify follow-up route revision**

Then send `我想去桔钓沙`. Expected: assistant returns a new detailed route including 桔钓沙 and shows add-to-map buttons.

- [ ] **Step 4: Verify JSON is hidden**

Inspect visible chat text. Expected: no ``` fences, no `"type"`, no `route_plan`, and no raw `{...}` JSON envelope.
