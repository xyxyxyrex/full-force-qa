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


def alignment_anchors(design: np.ndarray, live: np.ndarray, hard_anchors: list[dict[str, float]] | None = None) -> list[dict[str, float]]:
    """Find monotonic vertical anchors using hard semantic anchors + full-width edge-strip correlation."""
    design_edges = edge_image(design)
    live_edges = edge_image(live)
    design_height = design_edges.shape[0]
    live_height = live_edges.shape[0]
    strip_height = max(80, min(240, design_height // 18))
    step = max(strip_height + 40, design_height // 14)
    search_radius = max(180, live_height // 14)

    anchors: list[dict[str, float]] = [{"designY": 0.0, "liveY": 0.0, "confidence": 1.0, "hard": True}]

    if hard_anchors:
        for ha in hard_anchors:
            if "designY" in ha and "liveY" in ha:
                d_y = float(ha["designY"])
                l_y = float(ha["liveY"])
                conf = float(ha.get("confidence", 1.0))
                if 0 <= d_y < design_height and 0 <= l_y < live_height:
                    anchors.append({"designY": d_y, "liveY": l_y, "confidence": conf, "hard": True})

    for center in range(strip_height, design_height - strip_height, step):
        # If this region is close to a hard semantic anchor (< 50px), skip edge matching
        if any(abs(center - a["designY"]) < 50 for a in anchors if a.get("hard")):
            continue

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
        if confidence >= 0.40:
            anchors.append({"designY": float(center), "liveY": float(live_center), "confidence": float(confidence), "hard": False})

    anchors.append({"designY": float(design_height - 1), "liveY": float(live_height - 1), "confidence": 1.0, "hard": True})
    anchors.sort(key=lambda anchor: anchor["designY"])
    monotonic: list[dict[str, float]] = []
    for anchor in anchors:
        rejected = False
        while monotonic and anchor["liveY"] <= monotonic[-1]["liveY"] + 3:
            # Priority rule: hard anchors supersede soft visual template anchors
            if anchor.get("hard") and not monotonic[-1].get("hard"):
                monotonic.pop()
                continue
            if not anchor.get("hard") and monotonic[-1].get("hard"):
                rejected = True
                break
            if anchor["confidence"] <= monotonic[-1]["confidence"]:
                rejected = True
                break
            monotonic.pop()
        if not rejected:
            monotonic.append(anchor)
    if monotonic[-1]["designY"] < design_height - 1:
        monotonic.append({"designY": float(design_height - 1), "liveY": float(live_height - 1), "confidence": 1.0, "hard": True})
    return monotonic


def warp_live(design: np.ndarray, live: np.ndarray, anchors: list[dict[str, float]]) -> np.ndarray:
    height, width = design.shape[:2]
    design_y = np.array([anchor["designY"] for anchor in anchors], dtype=np.float32)
    live_y = np.array([anchor["liveY"] for anchor in anchors], dtype=np.float32)
    row_map = np.interp(np.arange(height, dtype=np.float32), design_y, live_y).astype(np.float32)
    map_x = np.tile(np.arange(width, dtype=np.float32), (height, 1))
    map_y = np.repeat(row_map[:, None], width, axis=1)
    return cv2.remap(live, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))


def evaluate_region_difference(design_bgr: np.ndarray, live_bgr: np.ndarray, x: int, y: int, w: int, h: int, max_shift_x: int = 14, max_shift_y: int = 16) -> float:
    """Calculates true material visual difference % after 2D local micro-alignment search (+/- max_shift_x, +/- max_shift_y px)."""
    H, W = design_bgr.shape[:2]
    if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > W or y + h > H:
        return 0.0

    crop_design = design_bgr[y:y+h, x:x+w]
    best_material_ratio = 1.0
    best_dx = 0
    best_dy = 0

    # 1. Coarse 2D search (step=2) for fast sub-region registration
    for dy in range(-max_shift_y, max_shift_y + 1, 2):
        ly = y + dy
        if ly < 0 or ly + h > H:
            continue
        for dx in range(-max_shift_x, max_shift_x + 1, 2):
            lx = x + dx
            if lx < 0 or lx + w > W:
                continue
            
            crop_live = live_bgr[ly:ly+h, lx:lx+w]
            abs_diff = cv2.absdiff(crop_design, crop_live)
            diff_gray = cv2.cvtColor(abs_diff, cv2.COLOR_BGR2GRAY)
            
            material_pixels = np.count_nonzero(diff_gray > 38)
            material_ratio = float(material_pixels) / float(diff_gray.size)

            if material_ratio < best_material_ratio:
                best_material_ratio = material_ratio
                best_dx = dx
                best_dy = dy

    # 2. Fine 1px refinement search around (best_dx, best_dy)
    for dy in range(best_dy - 1, best_dy + 2):
        ly = y + dy
        if ly < 0 or ly + h > H:
            continue
        for dx in range(best_dx - 1, best_dx + 2):
            lx = x + dx
            if lx < 0 or lx + w > W:
                continue
            
            crop_live = live_bgr[ly:ly+h, lx:lx+w]
            abs_diff = cv2.absdiff(crop_design, crop_live)
            diff_gray = cv2.cvtColor(abs_diff, cv2.COLOR_BGR2GRAY)
            
            material_pixels = np.count_nonzero(diff_gray > 38)
            material_ratio = float(material_pixels) / float(diff_gray.size)

            if material_ratio < best_material_ratio:
                best_material_ratio = material_ratio

    return round(best_material_ratio * 100.0, 1)


def feature_keypoint_anchors(design: np.ndarray, live: np.ndarray) -> list[dict[str, float]]:
    """Feature Keypoint Anchor Registration using ORB keypoints & descriptor matching."""
    design_gray = cv2.cvtColor(design, cv2.COLOR_BGR2GRAY)
    live_gray = cv2.cvtColor(live, cv2.COLOR_BGR2GRAY)

    orb = cv2.ORB_create(nfeatures=2000)
    kp1, des1 = orb.detectAndCompute(design_gray, None)
    kp2, des2 = orb.detectAndCompute(live_gray, None)

    if des1 is None or des2 is None or len(kp1) < 4 or len(kp2) < 4:
        return []

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = bf.match(des1, des2)
    matches = sorted(matches, key=lambda x: x.distance)

    raw_anchors = []
    for match in matches[:80]:
        pt1 = kp1[match.queryIdx].pt
        pt2 = kp2[match.trainIdx].pt
        raw_anchors.append({
            "designY": float(pt1[1]),
            "liveY": float(pt2[1]),
            "confidence": float(max(0.2, 1.0 - (match.distance / 100.0))),
            "hard": True
        })

    raw_anchors.sort(key=lambda a: a["designY"])
    return raw_anchors


def compare(design_path: str, live_path: str, hard_anchors_path: str | None = None, mode: str = "visual-surface") -> dict:
    design_original = read_image(design_path)
    live_original = read_image(live_path)
    working_width = min(960, design_original.shape[1], live_original.shape[1])
    design = resize_width(design_original, working_width)
    live = resize_width(live_original, working_width)

    scaled_hard_anchors: list[dict[str, float]] | None = None
    if hard_anchors_path:
        try:
            with open(hard_anchors_path, "r", encoding="utf-8") as f:
                raw_anchors = json.load(f)
                if isinstance(raw_anchors, list):
                    design_scale = design.shape[0] / max(1, design_original.shape[0])
                    live_scale = live.shape[0] / max(1, live_original.shape[0])
                    scaled_hard_anchors = [
                        {
                            "designY": float(item["designY"]) * design_scale,
                            "liveY": float(item["liveY"]) * live_scale,
                            "confidence": float(item.get("confidence", 1.0)),
                        }
                        for item in raw_anchors
                        if isinstance(item, dict) and "designY" in item and "liveY" in item
                    ]
        except Exception as err:
            print(f"Warning: Failed to load hard anchors: {err}", file=sys.stderr)

    if mode == "feature-anchor":
        feature_anchors = feature_keypoint_anchors(design, live)
        if feature_anchors:
            scaled_hard_anchors = (scaled_hard_anchors or []) + feature_anchors

    anchors = alignment_anchors(design, live, scaled_hard_anchors)
    aligned_live = warp_live(design, live, anchors)

    design_gray = cv2.cvtColor(design, cv2.COLOR_BGR2GRAY)
    live_gray = cv2.cvtColor(aligned_live, cv2.COLOR_BGR2GRAY)
    score, similarity_map = structural_similarity(design_gray, live_gray, data_range=255, full=True)
    change_map = np.clip(1.0 - similarity_map, 0.0, 1.0)
    
    # Material change thresholding: change_map > 0.32 ignores minor font anti-aliasing / sub-pixel rasterization
    changed_mask = (change_map > 0.32).astype(np.uint8) * 255
    changed_mask = cv2.morphologyEx(changed_mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7)), iterations=1)
    changed_mask = cv2.morphologyEx(changed_mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    contours, _ = cv2.findContours(changed_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    scale_x = design_original.shape[1] / working_width
    scale_y = design_original.shape[0] / design.shape[0]
    minimum_area = max(80, working_width * design.shape[0] * 0.00002)
    regions = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < minimum_area:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        
        # Calculate true visual difference after 2D local micro-alignment (+/- 16px search in X & Y)
        material_diff_percent = evaluate_region_difference(design, aligned_live, x, y, width, height, max_shift_x=16, max_shift_y=16)
        
        # Only retain region if material difference after local alignment is >= 5.0%
        if material_diff_percent >= 5.0:
            regions.append({
                "x": round(x * scale_x),
                "y": round(y * scale_y),
                "width": max(1, round(width * scale_x)),
                "height": max(1, round(height * scale_y)),
                "difference": material_diff_percent
            })
            
    regions.sort(key=lambda region: region["difference"], reverse=True)

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
    engine_name = "opencv-orb-feature" if mode == "feature-anchor" else "opencv-ssim"
    return {
        "success": True, "engine": engine_name, "similarity": round(float(score) * 100, 4),
        "changedPercent": round(float(np.count_nonzero(changed_mask)) / changed_mask.size * 100, 4),
        "heatmapDataUrl": "data:image/png;base64," + base64.b64encode(encoded.tobytes()).decode('ascii'),
        "regions": regions[:120],
        "anchors": [{"designY": round(anchor["designY"] * design_anchor_scale), "liveY": round(anchor["liveY"] * live_anchor_scale), "confidence": round(anchor["confidence"] * 100, 1)} for anchor in anchors],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--design', required=True)
    parser.add_argument('--live', required=True)
    parser.add_argument('--anchors', required=False, default=None)
    parser.add_argument('--mode', required=False, default='visual-surface', choices=['visual-surface', 'feature-anchor', 'token-auditor'])
    args = parser.parse_args()
    try:
        print(json.dumps(compare(args.design, args.live, args.anchors, mode=args.mode), separators=(',', ':')))
        return 0
    except Exception as error:
        print(json.dumps({"success": False, "error": str(error)}, separators=(',', ':')))
        return 1


if __name__ == '__main__':
    sys.exit(main())
