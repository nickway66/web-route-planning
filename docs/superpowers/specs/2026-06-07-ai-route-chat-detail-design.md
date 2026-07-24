# AI Route Chat Detail Design

## Goal

AI chat route responses must be useful without exposing JSON. When the assistant generates or revises a route, the user should see the concrete places and details in the chat bubble, and the route should still be addable to the map.

## Current Problems

The current backend and frontend successfully hide raw JSON, but the visible text is too short. A valid `route_plan` can appear as a one-line summary such as "including the following spots" without actually listing the spots. The frontend stores route metadata for buttons, but it does not expand `plan.days[].places` into user-visible text.

Follow-up messages such as "我想去桔钓沙" are also treated as plain chat if the latest user message does not contain explicit route words. In a conversation that already has a route planning context, such messages should revise or regenerate the route and return a fresh `route_plan`.

## Design

Backend route replies will be normalized from the parsed `plan`. Whenever a valid `route_plan` is produced, the final `reply` returned by the API should be a detailed itinerary derived from `plan.days[].places`, including place name, duration, cost, hours, and description when available. This generated reply remains natural language and never exposes the JSON envelope.

Backend route intent detection will become context-aware. If the latest user message is an explicit route request, behavior remains unchanged. If it is a short preference or place update and the recent conversation contains a route planning request or a previous assistant route plan, it should be treated as a route revision request. In that case the retry prompt should require a new `route_plan`.

Frontend route rendering will preserve the existing JSON-cleaning behavior, but `route_plan + plan` responses should display the detailed route text. If the backend reply is short or missing details, the frontend can generate the same detailed itinerary from `plan` as a defensive fallback. The existing `routePlaces`, `routeDayPlans`, `routeTargetCity`, and route action buttons continue to work.

## Testing

Backend tests should cover route reply detail generation and context-aware follow-up route requests. Frontend behavior should be verified by a production build and a browser-level flow: ask for a Shenzhen day route, confirm the bubble lists concrete places and details, then ask to include 桔钓沙 and confirm a new route response with add-to-map buttons.
