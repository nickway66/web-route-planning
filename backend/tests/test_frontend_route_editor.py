from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MAIN_JS = ROOT / "src" / "main.js"
MAP_SERVICE_JS = ROOT / "src" / "mapService.js"


def test_route_editor_recalc_auto_saves_without_manual_save_button():
    source = MAIN_JS.read_text(encoding="utf-8")

    assert "保存路线到本地缓存" not in source
    assert 'data-action="save-layer"' not in source
    assert 'if (action === "save-layer")' not in source
    assert "saveSelectedLayerToHistory({ showToast: false })" in source


def test_route_layer_click_focuses_immediately_and_paths_are_not_shifted():
    source = MAIN_JS.read_text(encoding="utf-8")
    map_source = MAP_SERVICE_JS.read_text(encoding="utf-8")

    assert "lineShift(" not in map_source
    assert "const shiftedPath = basePath;" in map_source
    layer_select_block = source[source.index('if (action === "layer-select")') : source.index('if (action === "layer-toggle")')]
    assert "focusLayer(nextId)" in layer_select_block
    assert "state.editorVisible = false" not in layer_select_block


def test_walking_routes_are_rendered_as_dashed_route_colored_polylines():
    source = MAP_SERVICE_JS.read_text(encoding="utf-8")

    assert "WALKING_DOT_SVG" not in source
    assert "drawWalkingDotOverlays" not in source
    assert "samplePathByScreenDistance" not in source
    assert "ROUTE_LINE_BLUE" not in source
    assert "strokeColor: getSegmentStrokeColor(segment, color)" in source
    assert "return [6, 8]" in source
    assert "segment.mode === \"walking\"" in source


def test_route_styles_match_requested_transport_ui():
    source = MAP_SERVICE_JS.read_text(encoding="utf-8")

    assert "getTransitKind(segment)" in source
    assert 'segment.transitKind === "bus"' in source
    assert "function getSegmentStrokeColor(segment = {}, routeColor = \"#1687ff\")" in source
    assert "return routeColor" in source
    assert "return [18, 10]" in source


def test_route_markers_prefer_display_location_for_large_pois():
    source = MAP_SERVICE_JS.read_text(encoding="utf-8")

    assert "function getPointDisplayPosition(point)" in source
    assert "point.displayLng ?? point.lng" in source
    assert "point.displayLat ?? point.lat" in source
    assert "const displayPosition = getPointDisplayPosition(point);" in source
    assert "this.poiInfoWindow.open(this.map, displayPosition);" in source
    assert "this.map.setZoomAndCenter(zoom, displayPosition);" in source


def test_route_points_can_be_reordered_with_sortable_without_recalc():
    source = MAIN_JS.read_text(encoding="utf-8")

    assert 'import Sortable from "sortablejs";' in source
    assert "function initPointSortable()" in source
    assert 'data-sortable="route-points"' in source
    assert 'data-point-index="${sourceIndex}"' in source
    assert "Sortable.create(list" in source
    assert "draggable: \".point-focus-item\"" in source
    assert "filter: \"button, select, input, textarea\"" in source
    assert "point-drag-handle" not in source
    assert 'data-action="point-drag"' not in source
    assert "function applyDraggedPointOrder(layer, orderedIndexes)" in source
    assert "pendingPointOrders: {}" in source
    assert "function getRouteEditorPointEntries(route)" in source
    assert "function applyPendingPointOrder(route)" in source

    drag_block = source[source.index("function applyDraggedPointOrder") : source.index("function renderHistoryOverlay")]
    assert "setPendingPointOrder(layer.route, orderedIndexes)" in drag_block
    assert "layer.route.points = orderedIndexes.map" not in drag_block
    assert "syncLayerSegmentModes(layer)" not in drag_block
    assert "persistLayersState()" not in drag_block
    assert "recalcSelectedLayer()" not in drag_block

    recalc_block = source[source.index("async function recalcSelectedLayer") : source.index("function saveSelectedLayerToHistory")]
    assert "applyPendingPointOrder(layer.route)" in recalc_block

    close_start = source.index('if (action === "close-new-route-editor"')
    close_end = source.index('if (action === "new-draft")', close_start)
    close_block = source[close_start:close_end]
    assert "clearPendingPointOrders()" in close_block

    route_select_block = source[source.index('if (action === "route-select")') : source.index('if (action === "route-toggle")')]
    assert "clearPendingPointOrders()" in route_select_block


def test_ai_route_notice_close_button_has_direct_event_binding():
    source = MAIN_JS.read_text(encoding="utf-8")

    assert 'const aiRouteNotice = document.getElementById("ai-route-notice");' in source
    assert 'aiRouteNotice?.addEventListener("click"' in source
    assert 'target.closest("[data-action=\'close-ai-route-notice\']")' in source
    assert "clearAIRouteNotice();" in source


def test_frontend_ai_chat_uses_backend_envelope_only():
    source = MAIN_JS.read_text(encoding="utf-8")

    assert "ZHIPU_CHAT_ENDPOINT" not in source
    assert "AI_SYSTEM_PROMPT" not in source
    assert "resolveZhipuModel" not in source
    assert "resolveZhipuCredentials" not in source
    assert "buildZhipuAuthorizationHeader" not in source
    assert "requestZhipuReply" not in source
    assert "const submissionMessages = await getSubmissionMessages(submission);" in source
    assert "chatWithAI(submissionMessages)" in source


def test_frontend_ai_chat_only_route_plan_creates_route_actions():
    source = MAIN_JS.read_text(encoding="utf-8")

    submit_block = source[source.index("async function submitAIChat") : source.index("function handleAIChatAction")]

    assert 'response.type === "route_plan"' in submit_block
    assert "response.plan" in submit_block
    assert 'routeActionStatus: "pending"' in submit_block
    assert 'response.type === "cancel_or_negative"' in submit_block
    assert "clearPendingAIRouteActions()" in submit_block
    assert "response.parsedPlan" not in submit_block

    route_branch = submit_block[submit_block.index('response.type === "route_plan"') : submit_block.index('response.type === "cancel_or_negative"')]
    non_route_branch = submit_block[submit_block.index('response.type === "cancel_or_negative"') :]
    assert 'routeActionStatus: "pending"' in route_branch
    assert 'routeActionStatus: "pending"' not in non_route_branch


def test_route_point_cards_place_map_replace_before_delete_icon():
    source = MAIN_JS.read_text(encoding="utf-8")
    styles = (ROOT / "src" / "styles.css").read_text(encoding="utf-8")

    assert 'class="point-card-main"' in source
    assert 'class="btn tiny point-replace-inline"' in source
    assert 'class="icon-btn delete point-delete-btn"' in source
    assert 'class="point-card-footer"' in source
    assert 'data-action="point-replace-map"' in source
    assert "grid-template-columns: minmax(0, 1fr) auto 24px;" in styles
    assert ".point-replace-inline" in styles
    assert ".point-card-footer" in styles
    assert "display: none;" in styles
    assert 'data-action="point-up"' not in source
    assert 'data-action="point-down"' not in source
    assert 'if (layer.route.points.length <= 2)' in source
    assert 'setToast("路线至少保留两个地点", "warning")' in source
