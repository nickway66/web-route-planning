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
