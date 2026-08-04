#!/usr/bin/env python3
"""Section-aware visual comparison worker for the Electron Automate workspace."""

from __future__ import annotations

import argparse
import base64
import json
import sys

import cv2
import numpy as np
from skimage.metrics import structural_similarity


def read_image(path: str) -> np.ndarray:
    image = cv2.imread(path, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Unable to decode image: {path}")
    return image


def resize_width(image: np.ndarray, width: int) -> np.ndarray:
    height = max(1, round(image.shape[0] * width / image.shape[1]))
    return cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA)


def edge_image(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 40, 120)


def alignment_anchors(design: np.ndarray, live: np.ndarray) -> list[dict[str, float]]:
    """Find monotonic vertical anchors using full-width edge-strip correlation."""
    design_edges = edge_image(design)
    live_edges = edge_image(live)
    design_height = design_edges.shape[0]
    live_height = live_edges.shape[0]
    strip_height = max(80, min(240, design_height // 18))
    step = max(strip_height + 40, design_height // 14)
    search_radius = max(180, live_height // 14)
    anchors: list[dict[str, float]] = [{"designY": 0.0, "liveY": 0.0, "confidence": 1.0}]

    for center in range(strip_height, design_height - strip_height, step):
        top = center - strip_height // 2
        template = design_edges[top:top + strip_height, :]
        expected = center / max(1, design_height) * live_height
        search_top = max(0, round(expected - search_radius - strip_height / 2))
        search_bottom = min(live_height, round(expected + search_radius + strip_height / 2))
        search = live_edges[search_top:search_bottom, :]
        if search.shape[0] < template.shape[0] or np.count_nonzero(template) < 30:
            continue
        result = cv2.matchTemplate(search, template, cv2.TM_CCOEFF_NORMED)
        _, confidence, _, location = cv2.minMaxLoc(result)
        live_center = search_top + location[1] + strip_height / 2
        if confidence >= 0.12:
            anchors.append({"designY": float(center), "liveY": float(live_center), "confidence": float(confidence)})

    anchors.append({"designY": float(design_height - 1), "liveY": float(live_height - 1), "confidence": 1.0})
    anchors.sort(key=lambda anchor: anchor["designY"])
    monotonic: list[dict[str, float]] = []
    for anchor in anchors:
        rejected = False
        while monotonic and anchor["liveY"] <= monotonic[-1]["liveY"] + 3:
            if anchor["confidence"] <= monotonic[-1]["confidence"]:
                rejected = True
                break
            monotonic.pop()
        if not rejected:
            monotonic.append(anchor)
    if monotonic[-1]["designY"] < design_height - 1:
        monotonic.append({"designY": float(design_height - 1), "liveY": float(live_height - 1), "confidence": 1.0})
    return monotonic


def warp_live(design: np.ndarray, live: np.ndarray, anchors: list[dict[str, float]]) -> np.ndarray:
    height, width = design.shape[:2]
    design_y = np.array([anchor["designY"] for anchor in anchors], dtype=np.float32)
    live_y = np.array([anchor["liveY"] for anchor in anchors], dtype=np.float32)
    row_map = np.interp(np.arange(height, dtype=np.float32), design_y, live_y).astype(np.float32)
    map_x = np.tile(np.arange(width, dtype=np.float32), (height, 1))
    map_y = np.repeat(row_map[:, None], width, axis=1)
    return cv2.remap(live, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))


def compare(design_path: str, live_path: str) -> dict:
    design_original = read_image(design_path)
    live_original = read_image(live_path)
    working_width = min(960, design_original.shape[1], live_original.shape[1])
    design = resize_width(design_original, working_width)
    live = resize_width(live_original, working_width)
    anchors = alignment_anchors(design, live)
    aligned_live = warp_live(design, live, anchors)

    design_gray = cv2.cvtColor(design, cv2.COLOR_BGR2GRAY)
    live_gray = cv2.cvtColor(aligned_live, cv2.COLOR_BGR2GRAY)
    score, similarity_map = structural_similarity(design_gray, live_gray, data_range=255, full=True)
    change_map = np.clip(1.0 - similarity_map, 0.0, 1.0)
    changed_mask = (change_map > 0.20).astype(np.uint8) * 255
    changed_mask = cv2.morphologyEx(changed_mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)), iterations=2)
    changed_mask = cv2.morphologyEx(changed_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    contours, _ = cv2.findContours(changed_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    scale_x = design_original.shape[1] / working_width
    scale_y = design_original.shape[0] / design.shape[0]
    minimum_area = max(60, working_width * design.shape[0] * 0.000015)
    regions = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < minimum_area:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        confidence = float(np.mean(change_map[y:y + height, x:x + width]))
        regions.append({"x": round(x * scale_x), "y": round(y * scale_y), "width": max(1, round(width * scale_x)), "height": max(1, round(height * scale_y)), "difference": round(confidence * 100, 1)})
    regions.sort(key=lambda region: region["width"] * region["height"], reverse=True)

    heat = cv2.applyColorMap(np.uint8(change_map * 255), cv2.COLORMAP_TURBO)
    muted = cv2.addWeighted(design, 0.28, np.zeros_like(design), 0.0, 0)
    overlay = cv2.addWeighted(muted, 0.45, heat, 0.75, 0)
    for region in regions[:80]:
        x = round(region["x"] / scale_x); y = round(region["y"] / scale_y)
        width = round(region["width"] / scale_x); height = round(region["height"] / scale_y)
        cv2.rectangle(overlay, (x, y), (x + width, y + height), (255, 255, 255), 1)
    ok, encoded = cv2.imencode('.png', overlay, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise RuntimeError('Unable to encode the comparison heatmap.')

    design_anchor_scale = design_original.shape[0] / design.shape[0]
    live_anchor_scale = live_original.shape[0] / live.shape[0]
    return {
        "success": True, "engine": "opencv-ssim", "similarity": round(float(score) * 100, 4),
        "changedPercent": round(float(np.count_nonzero(changed_mask)) / changed_mask.size * 100, 4),
        "heatmapDataUrl": "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode('ascii'),
        "regions": regions[:120],
        "anchors": [{"designY": round(anchor["designY"] * design_anchor_scale), "liveY": round(anchor["liveY"] * live_anchor_scale), "confidence": round(anchor["confidence"] * 100, 1)} for anchor in anchors],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--design', required=True)
    parser.add_argument('--live', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(compare(args.design, args.live), separators=(',', ':')))
        return 0
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}, separators=(',', ':')))
        return 1


if __name__ == '__main__':
    sys.exit(main())
