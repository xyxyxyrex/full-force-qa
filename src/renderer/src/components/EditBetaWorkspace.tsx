import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import "./EditBetaWorkspace.css";
import "./EditBetaWorkspace.ported.css";
import NativeStylePanel from "./NativeStylePanel";
import SmoothColorPicker from "./SmoothColorPicker";
import figmaIcon from "../assets/figma.png";
import type { DeviceFrame } from "./EditorWorkspace";
import type { AppHotkeys } from "../../../shared/types";
import type {
  CaptureInspectionOverlay,
  CanvasSelectionBox,
  CaptureViewportInfo,
} from "./FullsiteCanvasModal";
import { plainTextFromRichText } from "./RichTextEditor";
import { canvasViewportGeometry } from "../utils/canvasZoom";

function rendererCaptureWithTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export type FontInspectorMode = "off" | "selected" | "all";
export type InteractionMode = "edit" | "interact" | "eyedropper";

export interface EyedropperSample {
  hex: string;
  property: string;
  tag: string;
}

interface Props {
  sourceUrl: string;
  width: number;
  height: number;
  zoom: number;
  interactionMode: InteractionMode;
  revealAnimations: boolean;
  fontInspectorMode: FontInspectorMode;
  hotkeys: AppHotkeys;
  annotateMode?: boolean;
  boundaries: {
    enabled: boolean;
    scope: "selected" | "all";
    showMargins: boolean;
    showPaddings: boolean;
    showDimensions: boolean;
    showGaps: boolean;
  };
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  rulersOn: boolean;
  guidesOn: boolean;
  guidesAlwaysVisible: boolean;
  guides: Array<{ axis: "x" | "y"; position: number }>;
  viewportMode: "preset" | "free";
  onViewportResize: (width: number, height: number) => void;
  overlayImage?: string | null;
  overlayVisible?: boolean;
  overlayOpacity?: number;
  overlayMode?: "overlay" | "side-by-side" | "diff";
  overlayLabel?: string;
  figmaImage?: string | null;
  figmaUrl?: string;
  figmaViewMode?: "live" | "png";
  figmaPanelVisible?: boolean;
  snapshotImage?: string | null;
  snapshotLabel?: string;
  onFigmaViewModeChange?: (mode: "live" | "png") => void;
  onOpenFigmaSettings?: () => void;
  onCloseFigmaPanel?: () => void;
  onCloseSnapshotPanel?: () => void;
  onThumbnailCaptured?: (dataUrl: string) => void;
  canvasViewMode?: "single" | "multi";
  activeFrames?: DeviceFrame[];
  activeFrameId?: string;
  onSelectActiveFrame?: (frameId: string) => void;
  onToggleFrameEnabled?: (frameId: string) => void;
  onRemoveFrame?: (frameId: string) => void;
  annotations?: CanvasSelectionBox[];
  activeAnnotationViewport?: CaptureViewportInfo;
  selectedAnnotationId?: string | null;
  onSelectAnnotation?: (annotation: CanvasSelectionBox) => void;
  onAnnotateElement?: (element: RemoteElement) => void;
  onCanvasZoom?: (deltaY: number) => void;
  onHotkeyCommand?: (command: keyof AppHotkeys) => void;
  onEyedropperColorChange?: (sample: EyedropperSample | null) => void;
  accentColor?: string;
}

export interface EditBetaWorkspaceHandle {
  reload: () => void;
  deselect: () => void;
  undo: () => void;
  redo: () => void;
  refreshLayers: () => void;
  captureViewport: () => Promise<string | null>;
  captureFullPage: () => Promise<string | null>;
  getScrollY: () => Promise<number>;
  scrollBy: (deltaY: number) => void;
  scrollTo: (top: number) => void;
  getViewportGeometry: () => {
    left: number;
    top: number;
    width: number;
    height: number;
    pageWidth: number;
    pageHeight: number;
  } | null;
  getCaptureInspection: () => Promise<CaptureInspectionOverlay[]>;
  getPatches: () => Promise<any[]>;
}

interface PaletteColor {
  hex: string;
  count: number;
}
interface PaletteFont {
  family: string;
  count: number;
  preview?: string;
  loaded?: boolean;
}

interface RemoteElement {
  path: string;
  tag: string;
  id: string;
  className: string;
  text: string;
  attrs: Record<string, string>;
  styles: Record<string, string>;
  rect: { left: number; top: number; width: number; height: number };
  box: {
    marginTop: number;
    marginRight: number;
    marginBottom: number;
    marginLeft: number;
    paddingTop: number;
    paddingRight: number;
    paddingBottom: number;
    paddingLeft: number;
  };
  parentRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
  siblings: Array<{
    path: string;
    tag: string;
    rect: { left: number; top: number; width: number; height: number };
  }>;
  textEditable: boolean;
  cssSource: string;
}

interface LayerRow {
  path: string;
  depth: number;
  label: string;
  tag: string;
  hasChildren: boolean;
  ancestors: string[];
}

interface BridgeState {
  selected: RemoteElement | null;
  mode: InteractionMode;
  history: string[];
  historyIndex: number;
  patches: any[];
  scrollY: number;
}

interface BridgeOptions {
  revealAnimations: boolean;
  fontInspectorMode: FontInspectorMode;
  hotkeys: AppHotkeys;
  annotateMode: boolean;
  boundaries: Props["boundaries"];
  rulers: {
    enabled: boolean;
    guidesEnabled: boolean;
    guides: Array<{ axis: "x" | "y"; position: number }>;
  };
  zoomScale: number;
  accentColor: string;
}

// This function is serialized and executed inside the real guest page. It uses
// a fixed Shadow DOM overlay, so inspection never changes site layout or CSS.
function installEditBetaBridge() {
  const guestWindow = window as any;
  if (guestWindow.__fullForceEditBeta) {
    if (guestWindow.__fullForceEditBeta.version === 15) {
      guestWindow.__fullForceEditBeta.enable();
      return true;
    }
    try {
      guestWindow.__fullForceEditBeta.cleanup?.();
    } catch {}
  }

  let mode = "edit";
  let selected: HTMLElement | null = null;
  const selectedElements = new Set<HTMLElement>();
  let hovered: HTMLElement | null = null;
  let historyIndex = -1;
  const history: any[] = [];
  const basePatches: any[] = [];
  const stylePreviews = new Map<
    string,
    { before: string; beforePriority: string }
  >();
  const cssSourceCache = new Map<string, string>();
  const cssSourcePreviews = new Map<string, { before: string }>();
  let options: BridgeOptions = {
    revealAnimations: false,
    fontInspectorMode: "off",
    hotkeys: {} as AppHotkeys,
    annotateMode: false,
    boundaries: {
      enabled: false,
      scope: "selected",
      showMargins: true,
      showPaddings: true,
      showDimensions: true,
      showGaps: true,
    },
    rulers: {
      enabled: false,
      guidesEnabled: false,
      guides: [],
    },
    zoomScale: 1,
    accentColor: "#3b82f6",
  };

  const host = document.createElement("div");
  host.setAttribute("data-fullforce-beta-ui", "true");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    width: "0",
    height: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
  });
  const shadow = host.attachShadow({ mode: "open" });
  const box = document.createElement("div");
  Object.assign(box.style, {
    position: "fixed",
    display: "none",
    border: "2px solid #3b82f6",
    boxSizing: "border-box",
    pointerEvents: "none",
  });
  const label = document.createElement("div");
  Object.assign(label.style, {
    position: "fixed",
    display: "none",
    padding: "3px 7px",
    borderRadius: "4px",
    background: "#18181b",
    color: "#fff",
    font: "600 11px/1.2 system-ui,sans-serif",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  });
  const marginBox = document.createElement("div");
  Object.assign(marginBox.style, {
    position: "fixed",
    display: "none",
    border: "1px dashed #f59e0b",
    background: "rgba(245,158,11,.08)",
    boxSizing: "border-box",
    pointerEvents: "none",
  });
  const paddingBox = document.createElement("div");
  Object.assign(paddingBox.style, {
    position: "fixed",
    display: "none",
    border: "1px dashed #22c55e",
    background: "rgba(34,197,94,.08)",
    boxSizing: "border-box",
    pointerEvents: "none",
  });
  const highlights = document.createElement("div");
  Object.assign(highlights.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
  });
  const measurements = document.createElement("div");
  Object.assign(measurements.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
  });
  const selectionOutlines = document.createElement("div");
  Object.assign(selectionOutlines.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
  });
  const eyedropperOutline = document.createElement("div");
  Object.assign(eyedropperOutline.style, {
    position: "fixed",
    display: "none",
    boxSizing: "border-box",
    border: "2px solid #3b82f6",
    background: "rgba(59,130,246,.05)",
    pointerEvents: "none",
  });
  const eyedropperTooltip = document.createElement("div");
  Object.assign(eyedropperTooltip.style, {
    position: "fixed",
    display: "none",
    alignItems: "center",
    gap: "7px",
    minHeight: "28px",
    padding: "5px 8px",
    border: "1px solid #3b82f6",
    borderRadius: "6px",
    background: "#18181b",
    color: "#fff",
    boxShadow: "0 8px 24px rgba(0,0,0,.38)",
    font: "700 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace",
    whiteSpace: "nowrap",
    pointerEvents: "none",
  });
  const eyedropperSwatch = document.createElement("span");
  Object.assign(eyedropperSwatch.style, {
    width: "14px",
    height: "14px",
    flex: "0 0 14px",
    border: "1px solid rgba(255,255,255,.42)",
    borderRadius: "3px",
    boxShadow: "0 0 0 1px rgba(0,0,0,.35)",
  });
  const eyedropperValue = document.createElement("strong");
  const eyedropperHint = document.createElement("span");
  eyedropperHint.textContent = "Ctrl+C";
  Object.assign(eyedropperHint.style, {
    color: "#a1a1aa",
    fontSize: "9px",
    fontWeight: "600",
  });
  eyedropperTooltip.append(eyedropperSwatch, eyedropperValue, eyedropperHint);
  shadow.append(highlights, measurements, selectionOutlines, marginBox, paddingBox, box, label, eyedropperOutline, eyedropperTooltip);
  document.documentElement.appendChild(host);
  const captureInspectionHost = document.createElement("div");
  captureInspectionHost.setAttribute("data-fullforce-beta-ui", "true");
  Object.assign(captureInspectionHost.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    overflow: "hidden",
    contain: "strict",
    zIndex: "2147483646",
    pointerEvents: "none",
  });
  const captureInspectionShadow = captureInspectionHost.attachShadow({ mode: "open" });
  const captureInspectionLayer = document.createElement("div");
  Object.assign(captureInspectionLayer.style, {
    position: "absolute",
    top: "0",
    left: "0",
    pointerEvents: "none",
  });
  captureInspectionShadow.appendChild(captureInspectionLayer);
  document.documentElement.appendChild(captureInspectionHost);
  let highlightedElements: HTMLElement[] = [];
  let highlightedColor = "#a78bfa";
  let highlightFrame = 0;
  let measurementFrame = 0;
  let captureInspectionFrame = 0;
  let captureInspectionForced = false;
  let lastCaptureInspectionSnapshot: CaptureInspectionOverlay[] = [];

  const inspectionElement = (
    className: string,
    styles: Record<string, string>,
    text = "",
  ) => {
    const element = document.createElement("div");
    element.className = className;
    element.textContent = text;
    Object.assign(element.style, styles);
    captureInspectionLayer.appendChild(element);
    return element;
  };

  const renderCaptureInspection = () => {
    captureInspectionFrame = 0;
    captureInspectionLayer.replaceChildren();
    const connectedSelections = Array.from(selectedElements).filter(
      (element) => element.isConnected,
    );
    const selectedFontVisible =
      options.fontInspectorMode === "selected" && connectedSelections.length > 0;
    const selectedBoundariesVisible =
      options.boundaries.enabled &&
      options.boundaries.scope === "selected" &&
      connectedSelections.length > 0;
    const showProperties =
      options.fontInspectorMode === "all" ||
      selectedFontVisible ||
      (options.boundaries.enabled &&
        (options.boundaries.scope === "all" || selectedBoundariesVisible)) ||
      options.rulers.enabled ||
      options.rulers.guidesEnabled ||
      ((options.annotateMode || captureInspectionForced) && options.boundaries.enabled);
    const nextDisplay = showProperties ? "" : "none";
    if (captureInspectionHost.style.display !== nextDisplay) {
      captureInspectionHost.style.display = nextDisplay;
    }
    if (!showProperties || !document.body) return;

    const scrollX = window.scrollX || document.documentElement.scrollLeft || 0;
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const documentWidth = Math.ceil(
      Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth),
    );
    const documentHeight = Math.ceil(
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight),
    );
    const nextInspectionSnapshot: CaptureInspectionOverlay[] = [];
    Object.assign(captureInspectionLayer.style, {
      width: `${documentWidth}px`,
      height: `${documentHeight}px`,
      transform: `translate(${-scrollX}px, ${-scrollY}px)`,
      transformOrigin: "top left",
    });

    if (options.rulers.enabled) {
      nextInspectionSnapshot.push(
        {
          id: "inspection-ruler-top",
          kind: "ruler-top",
          coordinateSpace: "page",
          xPx: 0,
          yPagePx: 0,
          widthPx: documentWidth,
          heightPx: 22,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        },
        {
          id: "inspection-ruler-left",
          kind: "ruler-left",
          coordinateSpace: "page",
          xPx: 0,
          yPagePx: 0,
          widthPx: 22,
          heightPx: documentHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        },
      );
      inspectionElement("qa-capture-ruler-top", {
        position: "absolute",
        left: "0",
        top: "0",
        width: `${documentWidth}px`,
        height: "22px",
        boxSizing: "border-box",
        borderBottom: "1px solid #52525b",
        background: "repeating-linear-gradient(90deg,#71717a 0 1px,transparent 1px 10px),#18181b",
        opacity: "0.92",
      });
      inspectionElement("qa-capture-ruler-left", {
        position: "absolute",
        left: "0",
        top: "0",
        width: "22px",
        height: `${documentHeight}px`,
        boxSizing: "border-box",
        borderRight: "1px solid #52525b",
        background: "repeating-linear-gradient(0deg,#71717a 0 1px,transparent 1px 10px),#18181b",
        opacity: "0.92",
      });
      for (let x = 0; x < documentWidth; x += 100) {
        inspectionElement("qa-capture-ruler-label", {
          position: "absolute",
          left: `${x + 3}px`,
          top: "3px",
          color: "#d4d4d8",
          font: "8px/1 monospace",
          whiteSpace: "nowrap",
        }, String(x));
      }
      for (let y = 100; y < documentHeight; y += 100) {
        inspectionElement("qa-capture-ruler-label", {
          position: "absolute",
          left: "3px",
          top: `${y + 3}px`,
          color: "#d4d4d8",
          font: "8px/1 monospace",
          writingMode: "vertical-rl",
          whiteSpace: "nowrap",
        }, String(y));
      }
    }

    if (options.rulers.guidesEnabled) {
      for (const [guideIndex, guide] of (options.rulers.guides || []).entries()) {
        const isHorizontal = guide.axis === "x";
        const position = Math.max(0, Math.min(1, Number(guide.position) || 0));
        const guideLeft = isHorizontal ? 0 : position * window.innerWidth;
        const guideTop = isHorizontal ? position * window.innerHeight : 0;
        const guideWidth = isHorizontal ? documentWidth : 1;
        const guideHeight = isHorizontal ? 1 : documentHeight;
        nextInspectionSnapshot.push({
          id: `inspection-guide-${guideIndex}`,
          kind: "guide",
          coordinateSpace: "page",
          xPx: guideLeft,
          yPagePx: guideTop,
          widthPx: guideWidth,
          heightPx: guideHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
        inspectionElement("qa-capture-guide", {
          position: "absolute",
          left: `${guideLeft}px`,
          top: `${guideTop}px`,
          width: `${guideWidth}px`,
          height: `${guideHeight}px`,
          background: "#22d3ee",
          boxShadow: "0 0 0 1px rgba(8,145,178,.22)",
        });
      }
    }

    const inspectEveryElement =
      options.fontInspectorMode === "all" ||
      (options.boundaries.enabled && options.boundaries.scope === "all");
    const allElements = inspectEveryElement
      ? Array.from(document.body.querySelectorAll<HTMLElement>("*"))
      : connectedSelections;
    let rendered = 0;
    for (const element of allElements) {
      if (rendered >= 800 || isUi(element)) continue;
      const computed = getComputedStyle(element);
      if (
        computed.display === "none" ||
        computed.visibility === "hidden" ||
        Number(computed.opacity) === 0
      ) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const isPositioned = computed.position === "fixed" || computed.position === "sticky";
      const left = rect.left + (isPositioned ? 0 : scrollX);
      const top = rect.top + (isPositioned ? 0 : scrollY);
      if (
        left + rect.width < 0 ||
        top + rect.height < 0 ||
        left > documentWidth ||
        top > documentHeight
      ) continue;

      const directText = Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim(),
      );
      const textElement =
        directText ||
        /^(H[1-6]|P|A|LI|LABEL|BUTTON|TD|TH|BLOCKQUOTE|FIGCAPTION|INPUT|TEXTAREA)$/i.test(
          element.tagName,
        );
      const boundaryDetails: string[] = [];
      type PropertyBadge = {
        text: string;
        color: string;
        background: string;
        border: string;
      };
      const boundaryBadges: PropertyBadge[] = [];
      const fontBadges: PropertyBadge[] = [];
      let fontDetail = "";
      const shouldShowBoundary =
        options.boundaries.enabled &&
        (options.boundaries.scope === "all" || selectedElements.has(element));

      if (shouldShowBoundary) {
        inspectionElement("qa-capture-boundary", {
          position: "absolute",
          left: `${left}px`,
          top: `${top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          boxSizing: "border-box",
          border: "1px solid rgba(59,130,246,.72)",
          background: "rgba(59,130,246,.025)",
        });
        if (options.boundaries.showDimensions) {
          const detail = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
          boundaryDetails.push(detail);
          // Selected elements already have the editable dimensions badge at
          // bottom-right; avoid repeating it in the top-right box-model chips.
          if (!selectedElements.has(element))
            boundaryBadges.push({ text: detail, color: "#fbcfe8", background: "rgba(131,24,67,.94)", border: "rgba(236,72,153,.82)" });
        }
        if (options.boundaries.showMargins) {
          const values = [computed.marginTop, computed.marginRight, computed.marginBottom, computed.marginLeft]
            .map((value) => Math.round(parseFloat(value) || 0));
          const detail = `M ${values.join("/")}`;
          boundaryDetails.push(detail);
          boundaryBadges.push({ text: detail, color: "#fef3c7", background: "rgba(120,53,15,.94)", border: "rgba(245,158,11,.82)" });
          const mt = values[0], mr = values[1], mb = values[2], ml = values[3];
          if (mt || mr || mb || ml) {
            inspectionElement("qa-capture-margin", {
              position: "absolute",
              left: `${left - ml}px`,
              top: `${top - mt}px`,
              width: `${rect.width + ml + mr}px`,
              height: `${rect.height + mt + mb}px`,
              boxSizing: "border-box",
              border: "1px dashed rgba(245,158,11,.7)",
            });
          }
        }
        if (options.boundaries.showPaddings) {
          const values = [computed.paddingTop, computed.paddingRight, computed.paddingBottom, computed.paddingLeft]
            .map((value) => Math.round(parseFloat(value) || 0));
          const detail = `P ${values.join("/")}`;
          boundaryDetails.push(detail);
          boundaryBadges.push({ text: detail, color: "#dcfce7", background: "rgba(20,83,45,.94)", border: "rgba(34,197,94,.82)" });
          const pt = values[0], pr = values[1], pb = values[2], pl = values[3];
          if (pt || pr || pb || pl) {
            inspectionElement("qa-capture-padding", {
              position: "absolute",
              left: `${left + pl}px`,
              top: `${top + pt}px`,
              width: `${Math.max(0, rect.width - pl - pr)}px`,
              height: `${Math.max(0, rect.height - pt - pb)}px`,
              boxSizing: "border-box",
              border: "1px dashed rgba(34,197,94,.72)",
            });
          }
        }
        if (options.boundaries.showGaps && computed.gap && computed.gap !== "normal") {
          const detail = `Gap ${computed.gap}`;
          boundaryDetails.push(detail);
          boundaryBadges.push({ text: detail, color: "#f3e8ff", background: "rgba(88,28,135,.94)", border: "rgba(168,85,247,.82)" });
        }
      }

      const shouldShowFont =
        textElement &&
        (options.fontInspectorMode === "all" ||
          (options.fontInspectorMode === "selected" && selectedElements.has(element)));
      if (shouldShowFont) {
        const family = computed.fontFamily.split(",")[0].replace(/["']/g, "").trim() || "Sans";
        fontDetail = `${family} ${computed.fontSize}/${computed.fontWeight}`;
        fontBadges.push({ text: fontDetail, color: "#bae6fd", background: "rgba(12,74,110,.94)", border: "rgba(56,189,248,.82)" });
      }

      if (boundaryDetails.length) {
        nextInspectionSnapshot.push({
          id: `inspection-boundary-${rendered}`,
          kind: "boundary",
          text: boundaryDetails.join(" · "),
          coordinateSpace: "page",
          xPx: left,
          yPagePx: top,
          widthPx: rect.width,
          heightPx: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
      }
      if (fontDetail) {
        nextInspectionSnapshot.push({
          id: `inspection-font-${rendered}`,
          kind: "font",
          text: fontDetail,
          coordinateSpace: "page",
          xPx: left,
          yPagePx: top,
          widthPx: rect.width,
          heightPx: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
      }

      const renderBadgeGroup = (
        badges: PropertyBadge[],
        alignment: "left" | "right",
      ) => {
        if (!badges.length) return;
        const canvasScale = Math.max(0.25, options.zoomScale || 1);
        const inverseZoom = 1 / canvasScale;
        const physicalWidth = rect.width * canvasScale;
        const availableWidth = Math.max(54, physicalWidth / 2 - 4);
        const minimumTop = options.rulers.enabled ? 23 : 0;
        const badgeTop =
          top * canvasScale >= minimumTop + 20
            ? top - 19 * inverseZoom
            : top + 2 * inverseZoom;
        const horizontalAnchor = Math.max(
          0,
          Math.min(documentWidth, alignment === "left" ? left : left + rect.width),
        );
        const badgeHost = inspectionElement(
          `qa-capture-property-badges qa-capture-property-badges-${alignment}`,
          {
            position: "absolute",
            ...(alignment === "left"
              ? { left: `${horizontalAnchor}px` }
              : { right: `${Math.max(0, documentWidth - horizontalAnchor)}px` }),
            top: `${badgeTop}px`,
            maxWidth: `${availableWidth}px`,
            overflow: "hidden",
            display: "flex",
            justifyContent: alignment === "right" ? "flex-end" : "flex-start",
            gap: "3px",
            font: "700 9px/1.25 system-ui,sans-serif",
            whiteSpace: "nowrap",
            transform: `scale(${inverseZoom})`,
            transformOrigin: alignment === "right" ? "top right" : "top left",
            zIndex: "4",
          },
        );
        for (const badge of badges) {
          const chip = document.createElement("span");
          chip.textContent = badge.text;
          Object.assign(chip.style, {
            minWidth: "0",
            overflow: "hidden",
            padding: "2px 6px",
            border: `1px solid ${badge.border}`,
            borderRadius: "3px",
            background: badge.background,
            color: badge.color,
            boxShadow: "0 1px 4px rgba(0,0,0,.4)",
            textOverflow: "ellipsis",
          });
          badgeHost.appendChild(chip);
        }
      };

      // Keep typography and box-model data on opposite corners so both remain
      // readable when the same element is inspected at a low canvas zoom.
      renderBadgeGroup(fontBadges, "left");
      renderBadgeGroup(boundaryBadges, "right");
      rendered++;
    }
    lastCaptureInspectionSnapshot = nextInspectionSnapshot;
  };

  const scheduleCaptureInspection = () => {
    if (!captureInspectionFrame) {
      captureInspectionFrame = requestAnimationFrame(renderCaptureInspection);
    }
  };
  const captureInspectionObserver = new MutationObserver(scheduleCaptureInspection);
  captureInspectionObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden"],
  });

  const revealStyle = document.createElement("style");
  revealStyle.setAttribute("data-fullforce-beta-ui", "true");
  revealStyle.textContent = `[data-aos],[class*="reveal"],[class*="animate"],[class*="fade"]{opacity:1!important;visibility:visible!important;transform:none!important;animation:none!important;transition:none!important}`;
  const cursorStyle = document.createElement("style");
  cursorStyle.setAttribute("data-fullforce-beta-ui", "true");
  cursorStyle.textContent = `html *{cursor:pointer!important}input,textarea,[contenteditable="true"]{cursor:text!important}select{cursor:default!important}`;
  const eyedropperCursorStyle = document.createElement("style");
  eyedropperCursorStyle.setAttribute("data-fullforce-beta-ui", "true");
  eyedropperCursorStyle.textContent = `html,html *{cursor:crosshair!important}`;

  const cssEscape = (value: string) =>
    guestWindow.CSS?.escape
      ? guestWindow.CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const getPath = (el: Element | null): string => {
    if (!el || el === document.documentElement) return "html";
    if (el.id && document.querySelectorAll(`#${cssEscape(el.id)}`).length === 1)
      return `#${cssEscape(el.id)}`;
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const peers = Array.from(parent.children).filter(
          (child: Element) => child.tagName === node!.tagName,
        );
        if (peers.length > 1)
          part += `:nth-of-type(${peers.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  };
  const resolve = (path: string): HTMLElement | null => {
    try {
      return document.querySelector(path) as HTMLElement | null;
    } catch {
      return null;
    }
  };
  const isUi = (el: Element | null) =>
    !!el?.closest?.("[data-fullforce-beta-ui]");
  const localCssFor = (path: string) =>
    Array.from(
      document.querySelectorAll<HTMLStyleElement>(
        "style[data-fullforce-beta-css]",
      ),
    ).find((style) => style.dataset.fullforceBetaCss === path) || null;
  const getCssSource = (el: HTMLElement, styles: Record<string, string>) => {
    const path = getPath(el);
    const local = localCssFor(path);
    if (local) return local.textContent || "";
    const cached = cssSourceCache.get(path);
    if (cached != null) return cached;
    const matches: string[] = [];
    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          try {
            if (el.matches(rule.selectorText)) matches.push(rule.cssText);
          } catch {}
        } else if ("cssRules" in rule) {
          try {
            visit((rule as CSSGroupingRule).cssRules);
          } catch {}
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      if (
        (sheet.ownerNode as HTMLElement | null)?.hasAttribute?.(
          "data-fullforce-beta-css",
        )
      )
        continue;
      try {
        visit(sheet.cssRules);
      } catch {}
    }
    if (el.style.cssText)
      matches.push(
        `${path} {\n  ${el.style.cssText.split(";").filter(Boolean).join(";\n  ")};\n}`,
      );
    if (matches.length) {
      const source = matches.join("\n\n").slice(0, 30000);
      cssSourceCache.set(path, source);
      return source;
    }
    const fallback = Object.entries(styles)
      .filter(
        ([, value]) =>
          value && value !== "normal" && value !== "none" && value !== "auto",
      )
      .map(([property, value]) => `  ${property}: ${value};`)
      .join("\n");
    const source =
      `/* Computed fallback — edit to create a local override */\n${path} {\n${fallback}\n}`.slice(
        0,
        30000,
      );
    cssSourceCache.set(path, source);
    return source;
  };
  const describe = (el: HTMLElement | null): RemoteElement | null => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value;
    const props = [
      "display",
      "position",
      "width",
      "height",
      "min-width",
      "max-width",
      "min-height",
      "max-height",
      "top",
      "right",
      "bottom",
      "left",
      "z-index",
      "margin",
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
      "padding",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "gap",
      "row-gap",
      "column-gap",
      "color",
      "background-color",
      "font-family",
      "font-size",
      "font-weight",
      "font-style",
      "letter-spacing",
      "text-transform",
      "text-decoration",
      "text-decoration-line",
      "text-indent",
      "word-spacing",
      "line-height",
      "text-align",
      "vertical-align",
      "white-space",
      "border",
      "border-width",
      "border-top-width",
      "border-style",
      "border-top-style",
      "border-color",
      "border-top-color",
      "border-radius",
      "border-top-left-radius",
      "border-top-right-radius",
      "border-bottom-left-radius",
      "border-bottom-right-radius",
      "opacity",
      "justify-content",
      "align-items",
      "align-content",
      "align-self",
      "flex-direction",
      "flex-wrap",
      "flex-grow",
      "flex-shrink",
      "flex-basis",
      "grid-template-columns",
      "grid-template-rows",
      "grid-column",
      "grid-row",
      "overflow",
      "overflow-x",
      "overflow-y",
      "object-fit",
      "box-shadow",
      "translate",
      "transform",
      "transition",
    ];
    const styles: Record<string, string> = {};
    props.forEach((prop) => {
      styles[prop] = cs.getPropertyValue(prop);
    });
    const rect = el.getBoundingClientRect();
    const number = (property: string) =>
      parseFloat(cs.getPropertyValue(property)) || 0;
    const textEditable =
      /^(p|h[1-6]|span|a|li|label|button|strong|em|small|blockquote|figcaption|td|th|dt|dd)$/i.test(
        el.tagName,
      ) ||
      (el.children.length === 0 && !!(el.textContent || "").trim());
    const parent = el.parentElement;
    const parentBounds = parent?.getBoundingClientRect();
    const siblings = parent
      ? Array.from(parent.children)
          .filter((child) => child !== el && !isUi(child))
          .map((child) => {
            const childRect = child.getBoundingClientRect();
            return {
              path: getPath(child),
              tag: child.tagName.toLowerCase(),
              rect: {
                left: childRect.left,
                top: childRect.top,
                width: childRect.width,
                height: childRect.height,
              },
            };
          })
          .filter((item) => item.rect.width > 0 && item.rect.height > 0)
      : [];
    return {
      path: getPath(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      className: typeof el.className === "string" ? el.className : "",
      text: (el.innerText || "").slice(0, 4000),
      attrs,
      styles,
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      },
      box: {
        marginTop: number("margin-top"),
        marginRight: number("margin-right"),
        marginBottom: number("margin-bottom"),
        marginLeft: number("margin-left"),
        paddingTop: number("padding-top"),
        paddingRight: number("padding-right"),
        paddingBottom: number("padding-bottom"),
        paddingLeft: number("padding-left"),
      },
      parentRect: parentBounds
        ? {
            left: parentBounds.left,
            top: parentBounds.top,
            width: parentBounds.width,
            height: parentBounds.height,
          }
        : null,
      siblings,
      textEditable,
      cssSource: getCssSource(el, styles),
    };
  };
  const renderSelectionOutlines = () => {
    selectionOutlines.replaceChildren();
    if (mode !== "edit") return;
    let index = 0;
    for (const element of Array.from(selectedElements)) {
      if (!element.isConnected) {
        selectedElements.delete(element);
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const outline = document.createElement("div");
      const isPrimary = element === selected;
      Object.assign(outline.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        boxSizing: "border-box",
        border: isPrimary ? "2px solid #2563eb" : "2px solid #8b5cf6",
        background: isPrimary ? "rgba(37,99,235,.035)" : "rgba(139,92,246,.035)",
        pointerEvents: "none",
      });
      outline.setAttribute("data-selection-index", String(++index));
      selectionOutlines.appendChild(outline);
    }
  };
  const positionOverlay = () => {
    renderSelectionOutlines();
    if (!selected || !selected.isConnected || mode !== "edit") {
      box.style.display = "none";
      label.style.display = "none";
      marginBox.style.display = "none";
      paddingBox.style.display = "none";
      return;
    }
    const rect = selected.getBoundingClientRect();
    const cs = getComputedStyle(selected);
    Object.assign(box.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    label.style.display = "none";
    if (options.boundaries.enabled && options.boundaries.showMargins) {
      const mt = parseFloat(cs.marginTop) || 0;
      const mr = parseFloat(cs.marginRight) || 0;
      const mb = parseFloat(cs.marginBottom) || 0;
      const ml = parseFloat(cs.marginLeft) || 0;
      Object.assign(marginBox.style, {
        display: "block",
        left: `${rect.left - ml}px`,
        top: `${rect.top - mt}px`,
        width: `${rect.width + ml + mr}px`,
        height: `${rect.height + mt + mb}px`,
      });
    } else marginBox.style.display = "none";
    if (options.boundaries.enabled && options.boundaries.showPaddings) {
      const pt = parseFloat(cs.paddingTop) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      const pb = parseFloat(cs.paddingBottom) || 0;
      const pl = parseFloat(cs.paddingLeft) || 0;
      Object.assign(paddingBox.style, {
        display: "block",
        left: `${rect.left + pl}px`,
        top: `${rect.top + pt}px`,
        width: `${Math.max(0, rect.width - pl - pr)}px`,
        height: `${Math.max(0, rect.height - pt - pb)}px`,
      });
    } else paddingBox.style.display = "none";
    // The responsive inspection layer owns the font and boundary chips.
    // Keeping this legacy guest label would duplicate the top-left font chip.
    box.style.display = "none";
    marginBox.style.display = "none";
    paddingBox.style.display = "none";
    label.style.display = "none";
  };
  const renderMeasurements = () => {
    measurementFrame = 0;
    measurements.replaceChildren();
    if (
      !options.boundaries.enabled ||
      !options.boundaries.showGaps ||
      mode !== "edit" ||
      !selected?.isConnected ||
      !hovered?.isConnected ||
      selected === hovered ||
      isUi(hovered)
    )
      return;

    const selectedRect = selected.getBoundingClientRect();
    const hoveredRect = hovered.getBoundingClientRect();
    if (
      !selectedRect.width ||
      !selectedRect.height ||
      !hoveredRect.width ||
      !hoveredRect.height
    )
      return;

    const hoverOutline = document.createElement("div");
    Object.assign(hoverOutline.style, {
      position: "fixed",
      left: `${hoveredRect.left}px`,
      top: `${hoveredRect.top}px`,
      width: `${hoveredRect.width}px`,
      height: `${hoveredRect.height}px`,
      boxSizing: "border-box",
      border: "1px dashed #60a5fa",
      background: "rgba(96,165,250,.04)",
      pointerEvents: "none",
    });
    measurements.appendChild(hoverOutline);

    const makeLine = (
      left: number,
      top: number,
      width: number,
      height: number,
    ) => {
      const line = document.createElement("div");
      Object.assign(line.style, {
        position: "fixed",
        left: `${left}px`,
        top: `${top}px`,
        width: `${Math.max(0, width)}px`,
        height: `${Math.max(0, height)}px`,
        boxSizing: "border-box",
        pointerEvents: "none",
        borderTop:
          width > 0 && height === 0 ? "1px dashed rgba(168,85,247,.95)" : "none",
        borderLeft:
          height > 0 && width === 0 ? "1px dashed rgba(168,85,247,.95)" : "none",
      });
      measurements.appendChild(line);
    };
    const makeLabel = (value: number, left: number, top: number) => {
      const badge = document.createElement("div");
      badge.textContent = `${Math.round(value)}px`;
      const inverseZoom = 1 / Math.max(0.1, options.zoomScale || 1);
      Object.assign(badge.style, {
        position: "fixed",
        left: `${left}px`,
        top: `${top}px`,
        transform: `translate(-50%,-50%) scale(${inverseZoom})`,
        transformOrigin: "center center",
        padding: "2px 4px",
        borderRadius: "2px",
        background: "rgba(168,85,247,.96)",
        color: "#fff",
        font: "600 10px/1.25 system-ui,sans-serif",
        whiteSpace: "nowrap",
        pointerEvents: "none",
      });
      measurements.appendChild(badge);
    };
    const horizontalTick = (x: number, y: number) => makeLine(x, y - 4, 0, 8);
    const verticalTick = (x: number, y: number) => makeLine(x - 4, y, 8, 0);
    const selectedCx = selectedRect.left + selectedRect.width / 2;
    const selectedCy = selectedRect.top + selectedRect.height / 2;
    const hoveredCx = hoveredRect.left + hoveredRect.width / 2;
    const hoveredCy = hoveredRect.top + hoveredRect.height / 2;
    const midX = (selectedCx + hoveredCx) / 2;
    const midY = (selectedCy + hoveredCy) / 2;

    let horizontalGap = 0;
    let horizontalStart = 0;
    if (hoveredRect.left > selectedRect.right) {
      horizontalGap = hoveredRect.left - selectedRect.right;
      horizontalStart = selectedRect.right;
    } else if (selectedRect.left > hoveredRect.right) {
      horizontalGap = selectedRect.left - hoveredRect.right;
      horizontalStart = hoveredRect.right;
    }

    let verticalGap = 0;
    let verticalStart = 0;
    if (hoveredRect.top > selectedRect.bottom) {
      verticalGap = hoveredRect.top - selectedRect.bottom;
      verticalStart = selectedRect.bottom;
    } else if (selectedRect.top > hoveredRect.bottom) {
      verticalGap = selectedRect.top - hoveredRect.bottom;
      verticalStart = hoveredRect.bottom;
    }

    if (horizontalGap > 0) {
      makeLine(horizontalStart, midY, horizontalGap, 0);
      horizontalTick(horizontalStart, midY);
      horizontalTick(horizontalStart + horizontalGap, midY);
      makeLabel(horizontalGap, horizontalStart + horizontalGap / 2, midY - 10);
    }
    if (verticalGap > 0) {
      makeLine(midX, verticalStart, 0, verticalGap);
      verticalTick(midX, verticalStart);
      verticalTick(midX, verticalStart + verticalGap);
      makeLabel(verticalGap, midX + 22, verticalStart + verticalGap / 2);
    }
    if (horizontalGap === 0 && verticalGap === 0) {
      const centerDx = Math.abs(selectedCx - hoveredCx);
      const centerDy = Math.abs(selectedCy - hoveredCy);
      if (centerDx > 1) {
        makeLine(Math.min(selectedCx, hoveredCx), midY, centerDx, 0);
        makeLabel(centerDx, midX, midY - 10);
      }
      if (centerDy > 1) {
        makeLine(midX, Math.min(selectedCy, hoveredCy), 0, centerDy);
        makeLabel(centerDy, midX + 22, midY);
      }
    }
  };
  const scheduleMeasurements = () => {
    if (!measurementFrame)
      measurementFrame = requestAnimationFrame(renderMeasurements);
  };
  const commit = (entry: any, patch?: any) => {
    history.splice(historyIndex + 1);
    if (patch) entry.patch = patch;
    history.push(entry);
    historyIndex = history.length - 1;
  };
  let inlineEditing: HTMLElement | null = null;
  let inlineBeforeHtml = "";
  let inlineOriginalEditable: string | null = null;
  const isTextEditable = (el: HTMLElement | null) =>
    !!el &&
    (/^(p|h[1-6]|span|a|li|label|button|strong|em|small|blockquote|figcaption|td|th|dt|dd)$/i.test(
      el.tagName,
    ) ||
      (el.children.length === 0 && !!(el.textContent || "").trim()));
  const finishInlineEdit = (save = true) => {
    const el = inlineEditing;
    if (!el) return;
    const path = getPath(el);
    const afterHtml = el.innerHTML;
    const beforeHtml = inlineBeforeHtml;
    const originalEditable = inlineOriginalEditable;
    inlineEditing = null;
    el.removeEventListener("input", onInlineInput);
    el.removeEventListener("blur", onInlineBlur);
    el.removeEventListener("keydown", onInlineKeyDown);
    originalEditable == null
      ? el.removeAttribute("contenteditable")
      : el.setAttribute("contenteditable", originalEditable);
    if (save && afterHtml !== beforeHtml) {
      const rect = el.getBoundingClientRect();
      const redo = () => {
        el.innerHTML = afterHtml;
      };
      const undo = () => {
        el.innerHTML = beforeHtml;
      };
      commit(
        { label: "Edit text inline", undo, redo },
        {
          type: "html",
          path,
          value: afterHtml,
          beforeValue: beforeHtml,
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            vw: window.innerWidth || document.documentElement.clientWidth || 1920,
            vh: window.innerHeight || document.documentElement.clientHeight || 1080,
          },
          tag: el.tagName.toLowerCase(),
        },
      );
    } else if (!save) el.innerHTML = beforeHtml;
    positionOverlay();
  };
  const onInlineInput = () => positionOverlay();
  const onInlineBlur = () => finishInlineEdit(true);
  const onInlineKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finishInlineEdit(true);
      selected?.blur();
    } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      finishInlineEdit(true);
      selected?.blur();
    }
  };
  const select = (el: HTMLElement | null, additive = false) => {
    if (inlineEditing && inlineEditing !== el) finishInlineEdit(true);
    if (!additive) selectedElements.clear();
    if (el && additive && selectedElements.has(el)) {
      selectedElements.delete(el);
      const remaining = Array.from(selectedElements);
      selected = remaining[remaining.length - 1] || null;
    } else {
      if (el) selectedElements.add(el);
      selected = el;
    }
    hovered = null;
    positionOverlay();
    scheduleMeasurements();
    scheduleCaptureInspection();
  };
  const deselect = () => {
    const previousSelection = selected;
    const activeInlineEditor = inlineEditing;
    if (inlineEditing) finishInlineEdit(true);
    selected = null;
    selectedElements.clear();
    hovered = null;
    if (activeInlineEditor?.isConnected) activeInlineEditor.blur();
    try {
      window.getSelection()?.removeAllRanges();
    } catch {}
    positionOverlay();
    scheduleMeasurements();
    scheduleCaptureInspection();
    return !!previousSelection;
  };
  const beginInlineEdit = (
    el: HTMLElement,
    clientX: number,
    clientY: number,
  ) => {
    if (!isTextEditable(el)) return;
    if (inlineEditing && inlineEditing !== el) finishInlineEdit(true);
    if (inlineEditing !== el) {
      inlineEditing = el;
      inlineBeforeHtml = el.innerHTML;
      inlineOriginalEditable = el.getAttribute("contenteditable");
      el.setAttribute("contenteditable", "true");
      el.addEventListener("input", onInlineInput);
      el.addEventListener("blur", onInlineBlur);
      el.addEventListener("keydown", onInlineKeyDown);
    }
    el.focus({ preventScroll: true });
    const caret = (document as any).caretPositionFromPoint?.(clientX, clientY);
    const legacyRange = !caret
      ? (document as any).caretRangeFromPoint?.(clientX, clientY)
      : null;
    const range = document.createRange();
    const selection = window.getSelection();
    try {
      if (caret?.offsetNode) range.setStart(caret.offsetNode, caret.offset);
      else if (legacyRange)
        range.setStart(legacyRange.startContainer, legacyRange.startOffset);
      else {
        range.selectNodeContents(el);
        range.collapse(false);
      }
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch {}
  };
  const colorToHex = (value: string) => {
    const match = value.match(
      /rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)(?:\D+([\d.]+))?\s*\)/i,
    );
    if (!match || (match[4] !== undefined && Number(match[4]) === 0)) return "";
    return `#${[match[1], match[2], match[3]]
      .map((part) =>
        Math.max(0, Math.min(255, Number(part)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`.toUpperCase();
  };
  let eyedropperSample: EyedropperSample | null = null;
  let eyedropperPayload = "";
  let eyedropperCopiedTimer = 0;
  const emitEyedropperSample = (sample: EyedropperSample | null) => {
    const payload = JSON.stringify(sample);
    if (payload === eyedropperPayload) return;
    eyedropperPayload = payload;
    console.info(`__FULLFORCE_EYEDROPPER__${payload}`);
  };
  const clearEyedropper = () => {
    eyedropperSample = null;
    eyedropperOutline.style.display = "none";
    eyedropperTooltip.style.display = "none";
    emitEyedropperSample(null);
  };
  const sampleElementColor = (element: HTMLElement): EyedropperSample | null => {
    const style = getComputedStyle(element);
    const sample = (value: string, property: string): EyedropperSample | null => {
      const hex = colorToHex(value);
      return hex ? { hex, property, tag: element.tagName.toLowerCase() } : null;
    };
    if (element instanceof SVGElement) {
      const vectorColor = sample(style.fill, "fill") || sample(style.stroke, "stroke");
      if (vectorColor) return vectorColor;
    }
    const background = sample(style.backgroundColor, "background");
    if (background) return background;
    const hasBorder = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
      .some((width) => (parseFloat(width) || 0) > 0);
    if (hasBorder) {
      const border = sample(style.borderTopColor, "border");
      if (border) return border;
    }
    const directText = Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim(),
    );
    if (directText || /^(A|BUTTON|INPUT|TEXTAREA|LABEL|H[1-6]|P|LI|SPAN|STRONG|EM)$/i.test(element.tagName)) {
      const textColor = sample(style.color, "text");
      if (textColor) return textColor;
    }
    let ancestor = element.parentElement;
    while (ancestor && ancestor !== document.documentElement) {
      const ancestorHex = colorToHex(getComputedStyle(ancestor).backgroundColor);
      if (ancestorHex) return { hex: ancestorHex, property: "background", tag: element.tagName.toLowerCase() };
      ancestor = ancestor.parentElement;
    }
    return sample(style.color, "text");
  };
  const renderEyedropper = (event: MouseEvent, target: HTMLElement | null) => {
    if (mode !== "eyedropper" || !target || isUi(target)) {
      clearEyedropper();
      return;
    }
    const sample = sampleElementColor(target);
    const rect = target.getBoundingClientRect();
    if (!sample || !rect.width || !rect.height) {
      clearEyedropper();
      return;
    }
    eyedropperSample = sample;
    const accent = options.accentColor || "#3b82f6";
    const inverseZoom = 1 / Math.max(0.1, options.zoomScale || 1);
    Object.assign(eyedropperOutline.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      borderColor: accent,
      borderWidth: `${Math.max(1, 2 * inverseZoom)}px`,
      background: `color-mix(in srgb, ${accent} 6%, transparent)`,
    });
    eyedropperSwatch.style.background = sample.hex;
    eyedropperValue.textContent = `${sample.hex} · ${sample.property}`;
    eyedropperHint.textContent = "Ctrl+C";
    Object.assign(eyedropperTooltip.style, {
      display: "flex",
      left: `${Math.max(4, Math.min(window.innerWidth - 190, event.clientX + 15))}px`,
      top: `${Math.max(4, Math.min(window.innerHeight - 38, event.clientY + 15))}px`,
      borderColor: accent,
      transform: `scale(${inverseZoom})`,
      transformOrigin: "top left",
    });
    emitEyedropperSample(sample);
  };
  const copyEyedropperSample = () => {
    if (!eyedropperSample?.hex) return;
    const hex = eyedropperSample.hex;
    const fallbackCopy = () => {
      const input = document.createElement("textarea");
      input.value = hex;
      Object.assign(input.style, { position: "fixed", opacity: "0" });
      document.body.appendChild(input);
      input.select();
      try { document.execCommand("copy"); } catch {}
      input.remove();
    };
    try {
      const operation = navigator.clipboard?.writeText(hex);
      if (operation) void operation.catch(fallbackCopy);
      else fallbackCopy();
    } catch {
      fallbackCopy();
    }
    eyedropperHint.textContent = "Copied";
    if (eyedropperCopiedTimer) window.clearTimeout(eyedropperCopiedTimer);
    eyedropperCopiedTimer = window.setTimeout(() => {
      eyedropperHint.textContent = "Ctrl+C";
    }, 900);
  };
  let suppressClickAfterPan = false;
  const onMove = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (mode === "eyedropper") {
      renderEyedropper(event, target);
      return;
    }
    if (mode !== "edit") return;
    hovered =
      !target ||
      isUi(target) ||
      target === document.body ||
      target === document.documentElement
        ? null
        : target;
    scheduleMeasurements();
  };
  const onMouseLeave = () => {
    hovered = null;
    scheduleMeasurements();
    clearEyedropper();
  };
  const onClick = (event: MouseEvent) => {
    if (mode === "eyedropper" && !isUi(event.target as Element)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      renderEyedropper(event, event.target as HTMLElement);
      copyEyedropperSample();
      return;
    }
    if (mode !== "edit" || isUi(event.target as Element)) return;
    if (suppressClickAfterPan) {
      suppressClickAfterPan = false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    const target = (hovered || event.target) as HTMLElement;
    if (
      inlineEditing &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.target === inlineEditing ||
        inlineEditing.contains(event.target as Node))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if ((window as any).__fullForceFrameId) {
      console.info(`__FULLFORCE_FRAME_CLICK__${(window as any).__fullForceFrameId}`);
    }
    const additive = event.ctrlKey || event.metaKey;
    select(target, additive);
    if (!additive && selected === target)
      beginInlineEdit(target, event.clientX, event.clientY);
  };
  const onFramePointerDown = () => {
    if ((window as any).__fullForceFrameId) {
      console.info(`__FULLFORCE_FRAME_CLICK__${(window as any).__fullForceFrameId}`);
    }
  };
  document.addEventListener("pointerdown", onFramePointerDown, true);
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseleave", onMouseLeave, true);
  document.addEventListener("click", onClick, true);
  let spacePressed = false;
  let panActive = false;
  let panShortcutCode = "";
  let panSequence = 0;
  let zoomSequence = 0;
  const editableTarget = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    return !!el?.closest?.('input,textarea,select,[contenteditable="true"]');
  };
  const emitPan = (active: boolean, event?: MouseEvent) =>
    console.info(
      `__FULLFORCE_PAN__${JSON.stringify({ screenX: event?.screenX || 0, screenY: event?.screenY || 0, active, sequence: ++panSequence })}`,
    );
  const normalizedShortcut = (binding: string) => {
    const parts = String(binding || "").split("+").map((part) => part.trim()).filter(Boolean);
    let ctrl = false, alt = false, shift = false, meta = false, key = "";
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === "ctrl" || lower === "control") ctrl = true;
      else if (lower === "alt" || lower === "option") alt = true;
      else if (lower === "shift") shift = true;
      else if (lower === "meta" || lower === "cmd" || lower === "command") meta = true;
      else if (lower === "space" || lower === "spacebar") key = "Space";
      else if (lower === "esc") key = "Escape";
      else key = part.length === 1 ? part.toUpperCase() : part;
    }
    return [ctrl && "Ctrl", alt && "Alt", shift && "Shift", meta && "Meta", key].filter(Boolean).join(" + ");
  };
  const shortcutFromEvent = (event: KeyboardEvent) => {
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return "";
    const key = event.code === "Space" || event.key === " "
      ? "Space"
      : event.key.length === 1
        ? event.key.toUpperCase()
        : event.key;
    return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta", key]
      .filter(Boolean)
      .join(" + ");
  };
  const commandFromEvent = (event: KeyboardEvent): keyof AppHotkeys | null => {
    const pressed = shortcutFromEvent(event);
    if (!pressed) return null;
    for (const [command, binding] of Object.entries(options.hotkeys || {})) {
      if (normalizedShortcut(String(binding)) === pressed) return command as keyof AppHotkeys;
    }
    return null;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      mode === "eyedropper" &&
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "c" &&
      !editableTarget(event.target)
    ) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      copyEyedropperSample();
      return;
    }
    const command = commandFromEvent(event);
    if (!command) return;
    if (editableTarget(event.target) && command !== "quickSave") return;
    if (
      command.startsWith("annotation") &&
      command !== "toggleAnnotate" &&
      !options.annotateMode
    ) return;
    if (command === "panMode") {
      spacePressed = true;
      panShortcutCode = event.code;
      event.preventDefault();
      return;
    }
    if (event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    console.info(`__FULLFORCE_HOTKEY__${command}`);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (spacePressed && event.code === panShortcutCode) {
      spacePressed = false;
      panShortcutCode = "";
      if (panActive) {
        panActive = false;
        emitPan(false);
      }
    }
  };
  const onPanDown = (event: MouseEvent) => {
    if (
      mode !== "edit" ||
      (event.button !== 1 && !(spacePressed && event.button === 0))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    suppressClickAfterPan = true;
    panActive = true;
    emitPan(true, event);
  };
  const onPanMove = (event: MouseEvent) => {
    if (!panActive) return;
    emitPan(true, event);
  };
  const onPanUp = (event: MouseEvent) => {
    if (panActive) {
      panActive = false;
      emitPan(false, event);
    }
  };
  const onZoomWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    console.info(
      `__FULLFORCE_ZOOM__${JSON.stringify({ deltaY: event.deltaY, sequence: ++zoomSequence })}`,
    );
  };
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("mousedown", onPanDown, true);
  document.addEventListener("mousemove", onPanMove, true);
  document.addEventListener("mouseup", onPanUp, true);
  document.addEventListener("wheel", onZoomWheel, {
    capture: true,
    passive: false,
  });
  const refreshViewportOverlays = () => {
    positionOverlay();
    scheduleMeasurements();
  };
  window.addEventListener("scroll", refreshViewportOverlays, true);
  window.addEventListener("resize", refreshViewportOverlays, true);
  window.addEventListener("scroll", scheduleCaptureInspection, true);
  window.addEventListener("resize", scheduleCaptureInspection, true);

  const applyPatch = (patch: any) => {
    const el = resolve(patch.path);
    if (!el) return false;
    if (patch.type === "style")
      el.style.setProperty(patch.property, patch.value, patch.priority || "");
    if (patch.type === "cssText") el.style.cssText = patch.value || "";
    if (patch.type === "cssSource") {
      let style = localCssFor(patch.path);
      if (!style) {
        style = document.createElement("style");
        style.dataset.fullforceBetaCss = patch.path;
        document.head.appendChild(style);
      }
      style.textContent = patch.value || "";
    }
    if (patch.type === "text") el.textContent = patch.value;
    if (patch.type === "html") el.innerHTML = patch.value;
    if (patch.type === "attribute")
      patch.value == null
        ? el.removeAttribute(patch.name)
        : el.setAttribute(patch.name, patch.value);
    if (patch.type === "duplicate" && el.parentNode)
      el.parentNode.insertBefore(el.cloneNode(true), el.nextSibling);
    if (patch.type === "delete") el.remove();
    if (patch.type === "move" && el.parentElement)
      patch.direction < 0
        ? el.parentElement.insertBefore(el, el.previousElementSibling)
        : el.parentElement.insertBefore(
            el,
            el.nextElementSibling?.nextSibling || null,
          );
    positionOverlay();
    return true;
  };

  const visibleElements = () =>
    Array.from(document.body?.querySelectorAll("*") || []).filter((node) => {
      if (isUi(node)) return false;
      const el = node as HTMLElement;
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        cs.display !== "none" &&
        cs.visibility !== "hidden"
      );
    }) as HTMLElement[];
  const renderHighlights = () => {
    highlightFrame = 0;
    highlights.replaceChildren();
    highlightedElements
      .filter((el) => el.isConnected)
      .slice(0, 500)
      .forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (
          rect.bottom < 0 ||
          rect.top > innerHeight ||
          rect.right < 0 ||
          rect.left > innerWidth
        )
          return;
        const marker = document.createElement("div");
        Object.assign(marker.style, {
          position: "fixed",
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          boxSizing: "border-box",
          border: `2px solid ${highlightedColor}`,
          background: `${highlightedColor}18`,
        });
        highlights.appendChild(marker);
      });
  };
  const scheduleHighlights = () => {
    if (!highlightFrame && highlightedElements.length)
      highlightFrame = requestAnimationFrame(renderHighlights);
  };
  const clearHighlights = () => {
    highlightedElements = [];
    if (highlightFrame) cancelAnimationFrame(highlightFrame);
    highlightFrame = 0;
    highlights.replaceChildren();
  };
  const highlight = (elements: HTMLElement[], color: string) => {
    highlightedElements = elements;
    highlightedColor = color;
    renderHighlights();
  };
  window.addEventListener("scroll", scheduleHighlights, true);
  window.addEventListener("resize", scheduleHighlights, true);

  const api = {
    version: 15,
    enable() {
      host.style.display = "";
      positionOverlay();
      scheduleMeasurements();
    },
    disable() {
      host.style.display = "none";
      measurements.replaceChildren();
      clearEyedropper();
    },
    setMode(next: string) {
      mode = next === "interact" ? "interact" : next === "eyedropper" ? "eyedropper" : "edit";
      if (mode === "edit" && !cursorStyle.isConnected)
        document.head.appendChild(cursorStyle);
      if (mode !== "edit" && cursorStyle.isConnected) cursorStyle.remove();
      if (mode === "eyedropper" && !eyedropperCursorStyle.isConnected)
        document.head.appendChild(eyedropperCursorStyle);
      if (mode !== "eyedropper" && eyedropperCursorStyle.isConnected)
        eyedropperCursorStyle.remove();
      if (mode !== "eyedropper") clearEyedropper();
      positionOverlay();
      scheduleMeasurements();
      return mode;
    },
    setOptions(next: BridgeOptions) {
      options = {
        ...options,
        ...next,
        boundaries: { ...options.boundaries, ...(next?.boundaries || {}) },
        rulers: { ...options.rulers, ...(next?.rulers || {}) },
      };
      const accent = options.accentColor || "#3b82f6";
      eyedropperOutline.style.borderColor = accent;
      eyedropperTooltip.style.borderColor = accent;
      if (options.revealAnimations && !revealStyle.isConnected)
        document.head.appendChild(revealStyle);
      if (!options.revealAnimations && revealStyle.isConnected)
        revealStyle.remove();
      positionOverlay();
      scheduleMeasurements();
      scheduleCaptureInspection();
      return true;
    },
    getState(): BridgeState {
      const activePatches = history
        .slice(0, historyIndex + 1)
        .map((item) => item.patch)
        .filter(Boolean);
      return {
        selected: describe(selected),
        mode: mode as any,
        history: history.map((item) => item.label),
        historyIndex,
        patches: basePatches.concat(activePatches),
        scrollY: window.scrollY || document.documentElement.scrollTop || 0,
      };
    },
    deselect,
    async prepareCapture(renderMode = "raster") {
      eyedropperOutline.style.visibility = "hidden";
      eyedropperTooltip.style.visibility = "hidden";
      captureInspectionForced = true;
      captureInspectionHost.style.visibility = "visible";
      renderCaptureInspection();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (renderMode === "metadata") {
        captureInspectionHost.style.visibility = "hidden";
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return true;
    },
    finishCapture() {
      eyedropperOutline.style.visibility = "visible";
      eyedropperTooltip.style.visibility = "visible";
      captureInspectionForced = false;
      captureInspectionHost.style.visibility = "visible";
      scheduleCaptureInspection();
      return true;
    },
    getCaptureInspection() {
      return lastCaptureInspectionSnapshot.map((overlay) => ({ ...overlay }));
    },
    getLayers() {
      const rows: LayerRow[] = [];
      let count = 0;
      const walk = (
        parent: Element,
        depth: number,
        ancestors: string[] = [],
      ) => {
        if (depth > 8 || count > 1800) return;
        for (const child of Array.from(parent.children)) {
          if (isUi(child)) continue;
          const html = child as HTMLElement;
          const tag = child.tagName.toLowerCase();
          const id = html.id ? `#${html.id}` : "";
          const cls =
            typeof html.className === "string" && html.className.trim()
              ? `.${html.className.trim().split(/\s+/).slice(0, 2).join(".")}`
              : "";
          const path = getPath(child);
          const hasChildren = Array.from(child.children).some(
            (nested) => !isUi(nested),
          );
          rows.push({
            path,
            depth,
            label: `${tag}${id}${cls}`,
            tag,
            hasChildren,
            ancestors,
          });
          count++;
          walk(child, depth + 1, ancestors.concat(path));
        }
      };
      if (document.body) walk(document.body, 0);
      return rows;
    },
    scanColors(): PaletteColor[] {
      const counts = new Map<string, number>();
      visibleElements().forEach((el) => {
        const cs = getComputedStyle(el);
        [
          "color",
          "backgroundColor",
          "borderTopColor",
          "borderRightColor",
          "borderBottomColor",
          "borderLeftColor",
        ].forEach((key) => {
          const hex = colorToHex((cs as any)[key] || "");
          if (hex) counts.set(hex, (counts.get(hex) || 0) + 1);
        });
      });
      return Array.from(counts, ([hex, count]) => ({ hex, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 80);
    },
    async scanFonts(): Promise<PaletteFont[]> {
      try {
        await document.fonts.ready;
      } catch {}
      const counts = new Map<string, number>();
      visibleElements().forEach((el) => {
        const family = getComputedStyle(el)
          .fontFamily.split(",")[0]
          .replace(/["']/g, "")
          .trim();
        if (family) counts.set(family, (counts.get(family) || 0) + 1);
      });
      return Array.from(counts, ([family, count]) => {
        const canvas = document.createElement("canvas");
        canvas.width = 480;
        canvas.height = 48;
        const context = canvas.getContext("2d");
        let preview = "";
        if (context) {
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = "#e4e4e7";
          context.textBaseline = "middle";
          context.font = `500 24px "${family.replace(/"/g, '\\"')}", sans-serif`;
          context.fillText(family, 4, 24, 440);
          try {
            preview = canvas.toDataURL("image/png");
          } catch {}
        }
        return {
          family,
          count,
          preview,
          loaded: document.fonts.check(`16px "${family.replace(/"/g, '\\"')}"`),
        };
      }).sort((a, b) => b.count - a.count);
    },
    highlightUsage(type: "color" | "font", values: string[]) {
      if (!values?.length) {
        clearHighlights();
        return 0;
      }
      const wanted = new Set(
        values.map((value) =>
          type === "color" ? value.toUpperCase() : value.toLowerCase(),
        ),
      );
      const matches = visibleElements().filter((el) => {
        const cs = getComputedStyle(el);
        if (type === "font")
          return wanted.has(
            cs.fontFamily
              .split(",")[0]
              .replace(/["']/g, "")
              .trim()
              .toLowerCase(),
          );
        return [
          "color",
          "backgroundColor",
          "borderTopColor",
          "borderRightColor",
          "borderBottomColor",
          "borderLeftColor",
        ].some((key) => wanted.has(colorToHex((cs as any)[key] || "")));
      });
      highlight(matches, type === "color" ? "#f472b6" : "#a78bfa");
      return matches.length;
    },
    selectPath(path: string) {
      const el = resolve(path);
      if (el) {
        select(el);
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      return describe(el);
    },
    selectParent() {
      if (selected?.parentElement && selected.parentElement !== document.body)
        select(selected.parentElement);
      return describe(selected);
    },
    setStyle(property: string, value: string) {
      if (!selected) return false;
      const el = selected;
      const previewKey = `${getPath(el)}::${property}`;
      const pending = stylePreviews.get(previewKey);
      const before = pending?.before ?? el.style.getPropertyValue(property);
      const beforePriority =
        pending?.beforePriority ?? el.style.getPropertyPriority(property);
      const after = value || "";
      const computed = getComputedStyle(el);
      const beforeVal = before || computed.getPropertyValue(property) || "";
      const rBefore = el.getBoundingClientRect();
      const vw = window.innerWidth || document.documentElement.clientWidth || 1920;
      const vh = window.innerHeight || document.documentElement.clientHeight || 1080;

      const redo = () =>
        after
          ? el.style.setProperty(property, after, "important")
          : el.style.removeProperty(property);
      const undo = () =>
        before
          ? el.style.setProperty(property, before, beforePriority)
          : el.style.removeProperty(property);
      redo();
      const rAfter = el.getBoundingClientRect();

      stylePreviews.delete(previewKey);
      commit(
        {
          label: `${el.tagName.toLowerCase()} · ${property} → ${after || "default"}`,
          undo,
          redo,
        },
        {
          type: "style",
          path: getPath(el),
          property,
          value: after,
          beforeValue: beforeVal,
          priority: after ? "important" : "",
          rectBefore: {
            left: Math.round(rBefore.left),
            top: Math.round(rBefore.top),
            width: Math.round(rBefore.width),
            height: Math.round(rBefore.height),
            vw,
            vh,
          },
          rectAfter: {
            left: Math.round(rAfter.left),
            top: Math.round(rAfter.top),
            width: Math.round(rAfter.width),
            height: Math.round(rAfter.height),
            vw,
            vh,
          },
          tag: el.tagName.toLowerCase(),
        },
      );
      positionOverlay();
      return true;
    },
    setCssText(value: string) {
      if (!selected) return false;
      const el = selected;
      const path = getPath(el);
      const before = el.style.cssText;
      const after = value || "";
      if (before === after) return true;
      const redo = () => {
        el.style.cssText = after;
      };
      const undo = () => {
        el.style.cssText = before;
      };
      redo();
      commit(
        { label: `CSS · ${el.tagName.toLowerCase()}`, undo, redo },
        { type: "cssText", path, value: after },
      );
      positionOverlay();
      return true;
    },
    previewCssSource(value: string, targetPath?: string) {
      const el = targetPath ? resolve(targetPath) : selected;
      if (!el) return false;
      const path = getPath(el);
      let style = localCssFor(path);
      if (!cssSourcePreviews.has(path))
        cssSourcePreviews.set(path, { before: style?.textContent || "" });
      if (!style?.isConnected) {
        style = document.createElement("style");
        style.dataset.fullforceBetaCss = path;
        document.head.appendChild(style);
      }
      style.textContent = value || "";
      cssSourceCache.delete(path);
      positionOverlay();
      return true;
    },
    setCssSource(value: string, targetPath?: string) {
      const el = targetPath ? resolve(targetPath) : selected;
      if (!el) return false;
      const path = getPath(el);
      let style = localCssFor(path);
      const pending = cssSourcePreviews.get(path);
      const before = pending?.before ?? style?.textContent ?? "";
      const after = value || "";
      cssSourcePreviews.delete(path);
      if (before === after) return true;
      const ensure = () => {
        if (!style?.isConnected) {
          style = document.createElement("style");
          style.dataset.fullforceBetaCss = path;
          document.head.appendChild(style);
        }
        return style;
      };
      const redo = () => {
        ensure().textContent = after;
      };
      const undo = () => {
        if (before) ensure().textContent = before;
        else style?.remove();
      };
      redo();
      cssSourceCache.delete(path);
      commit(
        {
          label: `${el.tagName.toLowerCase()} · stylesheet override`,
          undo,
          redo,
        },
        { type: "cssSource", path, value: after },
      );
      positionOverlay();
      return true;
    },
    previewStyle(property: string, value: string) {
      if (!selected) return false;
      const key = `${getPath(selected)}::${property}`;
      if (!stylePreviews.has(key))
        stylePreviews.set(key, {
          before: selected.style.getPropertyValue(property),
          beforePriority: selected.style.getPropertyPriority(property),
        });
      value
        ? selected.style.setProperty(property, value, "important")
        : selected.style.removeProperty(property);
      positionOverlay();
      return true;
    },
    setText(value: string) {
      if (!selected) return false;
      if (inlineEditing) finishInlineEdit(true);
      const el = selected;
      const rect = el.getBoundingClientRect();
      const before = el.textContent || "";
      const redo = () => {
        el.textContent = value;
      };
      const undo = () => {
        el.textContent = before;
      };
      redo();
      commit(
        { label: `${el.tagName.toLowerCase()} · text updated`, undo, redo },
        {
          type: "text",
          path: getPath(el),
          value,
          beforeValue: before,
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            vw: window.innerWidth || document.documentElement.clientWidth || 1920,
            vh: window.innerHeight || document.documentElement.clientHeight || 1080,
          },
          tag: el.tagName.toLowerCase(),
        },
      );
      positionOverlay();
      return true;
    },
    setHtml(value: string) {
      if (!selected) return false;
      if (inlineEditing) finishInlineEdit(true);
      const el = selected;
      const rect = el.getBoundingClientRect();
      const before = el.innerHTML;
      const redo = () => {
        el.innerHTML = value;
      };
      const undo = () => {
        el.innerHTML = before;
      };
      redo();
      commit(
        {
          label: `${el.tagName.toLowerCase()} · inline text updated`,
          undo,
          redo,
        },
        {
          type: "html",
          path: getPath(el),
          value,
          beforeValue: before,
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            vw: window.innerWidth || document.documentElement.clientWidth || 1920,
            vh: window.innerHeight || document.documentElement.clientHeight || 1080,
          },
          tag: el.tagName.toLowerCase(),
        },
      );
      positionOverlay();
      return true;
    },
    setAttribute(name: string, value: string | null) {
      if (!selected || !name) return false;
      const el = selected;
      const rect = el.getBoundingClientRect();
      const path = getPath(el);
      const before = el.getAttribute(name);
      const redo = () =>
        value == null || value === ""
          ? el.removeAttribute(name)
          : el.setAttribute(name, value);
      const undo = () =>
        before == null
          ? el.removeAttribute(name)
          : el.setAttribute(name, before);
      redo();
      commit(
        {
          label: `${el.tagName.toLowerCase()} · attribute ${name}`,
          undo,
          redo,
        },
        {
          type: "attribute",
          path,
          name,
          value: value || "",
          beforeValue: before || "",
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            vw: window.innerWidth || document.documentElement.clientWidth || 1920,
            vh: window.innerHeight || document.documentElement.clientHeight || 1080,
          },
          tag: el.tagName.toLowerCase(),
        },
      );
      return true;
    },
    duplicate() {
      if (!selected?.parentNode) return false;
      const original = selected;
      const clone = original.cloneNode(true) as HTMLElement;
      const parent = original.parentNode;
      if (!parent) return false;
      const next = original.nextSibling;
      const path = getPath(original);
      const redo = () => parent.insertBefore(clone, next);
      const undo = () => clone.remove();
      redo();
      commit(
        { label: "Duplicate element", undo, redo },
        { type: "duplicate", path },
      );
      select(clone);
      return true;
    },
    remove() {
      if (!selected?.parentNode) return false;
      const el = selected;
      const path = getPath(el);
      const parent = el.parentNode;
      if (!parent) return false;
      const next = el.nextSibling;
      const redo = () => el.remove();
      const undo = () => parent.insertBefore(el, next);
      redo();
      commit({ label: "Delete element", undo, redo }, { type: "delete", path });
      select(null);
      return true;
    },
    move(direction: number) {
      if (!selected?.parentElement) return false;
      const el = selected;
      const path = getPath(el);
      const parent = el.parentElement;
      if (!parent) return false;
      const oldNext = el.nextSibling;
      const redo = () =>
        direction < 0
          ? parent.insertBefore(el, el.previousElementSibling)
          : parent.insertBefore(el, el.nextElementSibling?.nextSibling || null);
      const undo = () => parent.insertBefore(el, oldNext);
      redo();
      commit(
        { label: direction < 0 ? "Move up" : "Move down", undo, redo },
        { type: "move", path, direction },
      );
      positionOverlay();
      return true;
    },
    reorder(targetPath: string, placement: "before" | "after") {
      if (!selected?.parentElement) return false;
      const el = selected;
      const sourcePath = getPath(el);
      const target = resolve(targetPath);
      if (!target || target === el || target.parentElement !== el.parentElement)
        return false;
      const parent = el.parentElement;
      if (!parent) return false;
      const oldNext = el.nextSibling;
      const redo = () =>
        parent.insertBefore(
          el,
          placement === "before" ? target : target.nextSibling,
        );
      const undo = () => parent.insertBefore(el, oldNext);
      redo();
      commit(
        { label: `Reorder ${placement}`, undo, redo },
        { type: "reorder", path: sourcePath, targetPath, placement },
      );
      positionOverlay();
      return true;
    },
    undo() {
      if (historyIndex < 0) return false;
      history[historyIndex].undo();
      historyIndex--;
      positionOverlay();
      return true;
    },
    redo() {
      if (historyIndex + 1 >= history.length) return false;
      historyIndex++;
      history[historyIndex].redo();
      positionOverlay();
      return true;
    },
    applyPatches(nextPatches: any[]) {
      const previousSelection = selected;
      const previousSelections = Array.from(selectedElements);
      for (const patch of nextPatches || []) {
        const target = resolve(patch.path);
        if (!target) continue;
        selected = target;
        if (patch.type === "style") api.setStyle(patch.property, patch.value);
        else if (patch.type === "cssText") api.setCssText(patch.value);
        else if (patch.type === "cssSource") api.setCssSource(patch.value);
        else if (patch.type === "text") api.setText(patch.value);
        else if (patch.type === "html") api.setHtml(patch.value);
        else if (patch.type === "attribute")
          api.setAttribute(patch.name, patch.value);
        else if (patch.type === "duplicate") api.duplicate();
        else if (patch.type === "delete") api.remove();
        else if (patch.type === "move") api.move(patch.direction);
        else if (patch.type === "reorder")
          api.reorder(patch.targetPath, patch.placement);
      }
      selected = previousSelection?.isConnected ? previousSelection : null;
      selectedElements.clear();
      previousSelections.forEach((element) => {
        if (element.isConnected) selectedElements.add(element);
      });
      positionOverlay();
      return historyIndex + 1;
    },
    revertAll() {
      if (inlineEditing) finishInlineEdit(true);
      while (historyIndex >= 0) {
        history[historyIndex].undo();
        historyIndex--;
      }
      for (const [path, preview] of cssSourcePreviews) {
        const style = localCssFor(path);
        if (preview.before) {
          if (style) style.textContent = preview.before;
        } else style?.remove();
      }
      history.splice(0);
      basePatches.splice(0);
      stylePreviews.clear();
      cssSourcePreviews.clear();
      selected = null;
      selectedElements.clear();
      clearHighlights();
      positionOverlay();
      return true;
    },
    cleanup() {
      if (inlineEditing) finishInlineEdit(true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseleave", onMouseLeave, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("pointerdown", onFramePointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("mousedown", onPanDown, true);
      document.removeEventListener("mousemove", onPanMove, true);
      document.removeEventListener("mouseup", onPanUp, true);
      document.removeEventListener("wheel", onZoomWheel, true);
      window.removeEventListener("scroll", refreshViewportOverlays, true);
      window.removeEventListener("resize", refreshViewportOverlays, true);
      window.removeEventListener("scroll", scheduleCaptureInspection, true);
      window.removeEventListener("resize", scheduleCaptureInspection, true);
      window.removeEventListener("scroll", scheduleHighlights, true);
      window.removeEventListener("resize", scheduleHighlights, true);
      if (measurementFrame) cancelAnimationFrame(measurementFrame);
      measurementFrame = 0;
      measurements.replaceChildren();
      selectionOutlines.replaceChildren();
      if (captureInspectionFrame) cancelAnimationFrame(captureInspectionFrame);
      captureInspectionFrame = 0;
      captureInspectionObserver.disconnect();
      clearHighlights();
      revealStyle.remove();
      cursorStyle.remove();
      eyedropperCursorStyle.remove();
      if (eyedropperCopiedTimer) window.clearTimeout(eyedropperCopiedTimer);
      host.remove();
      captureInspectionHost.remove();
      delete guestWindow.__fullForceEditBeta;
    },
    getPatches() {
      const activePatches = (history || [])
        .slice(0, historyIndex + 1)
        .map((item: any) => item?.patch)
        .filter(Boolean);
      const all = (basePatches || []).concat(activePatches);
      return all.map((p: any) => ({
        type: p.type,
        path: p.path,
        property: p.property,
        value: p.value,
        beforeValue: p.beforeValue,
        name: p.name,
        rectBefore: p.rectBefore || p.rect,
        rectAfter: p.rectAfter || p.rect,
        rect: p.rectAfter || p.rect,
        tag: p.tag,
      }));
    },
  };
  guestWindow.__fullForceEditBeta = api;
  return true;
}

function highlightCssSource(source: string) {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return source
    .split("\n")
    .map((line, index) => {
      const trimmed = line.trim();
      let highlighted = escape(line) || " ";
      if (
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*") ||
        trimmed.endsWith("*/")
      )
        highlighted = `<span class="css-comment">${escape(line)}</span>`;
      else if (trimmed.endsWith("{") || trimmed.startsWith("@"))
        highlighted = `<span class="css-selector">${escape(line)}</span>`;
      const declaration = line.match(/^(\s*)([-\w]+)(\s*:\s*)(.*?)(;?\s*)$/);
      if (declaration && !trimmed.startsWith("/*"))
        highlighted = `${escape(declaration[1])}<span class="css-property">${escape(declaration[2])}</span><span class="css-punctuation">${escape(declaration[3])}</span><span class="css-value">${escape(declaration[4])}</span><span class="css-punctuation">${escape(declaration[5])}</span>`;
      return `<span class="css-line" data-line="${index + 1}">${highlighted}</span>`;
    })
    .join("");
}

function formatCssSource(source: string) {
  let output = "";
  let indent = 0;
  let quote = "";
  let escaped = false;
  let comment = false;
  let parentheses = 0;
  const line = () => {
    output = output.replace(/[ \t]+$/g, "");
    if (!output.endsWith("\n")) output += "\n";
    output += "  ".repeat(indent);
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (comment) {
      output += char;
      if (char === "*" && next === "/") {
        output += "/";
        index++;
        comment = false;
      }
      continue;
    }
    if (!quote && char === "/" && next === "*") {
      output += "/*";
      index++;
      comment = true;
      continue;
    }
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "(") {
      parentheses++;
      output += char;
      continue;
    }
    if (char === ")") {
      parentheses = Math.max(0, parentheses - 1);
      output += char;
      continue;
    }
    if (char === "{" && parentheses === 0) {
      output = output.trimEnd() + " {";
      indent++;
      line();
      continue;
    }
    if (char === ";" && parentheses === 0) {
      output = output.trimEnd() + ";";
      line();
      continue;
    }
    if (char === "}" && parentheses === 0) {
      indent = Math.max(0, indent - 1);
      output =
        output.trimEnd() +
        "\n" +
        "  ".repeat(indent) +
        "}\n\n" +
        "  ".repeat(indent);
      continue;
    }
    if (/\s/.test(char)) {
      if (output && !/[\s]/.test(output[output.length - 1])) output += " ";
      continue;
    }
    if (char === ":" && parentheses === 0) {
      output = output.trimEnd() + ": ";
      continue;
    }
    output += char;
  }
  return output.trim();
}

function EditableBoundaryValue({
  value,
  className,
  property,
  onCommit,
}: {
  value: number;
  className: string;
  property: string;
  onCommit: (property: string, value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(value)));
  useEffect(() => setDraft(String(Math.round(value))), [value]);
  const commit = () => {
    const numeric = Number.parseFloat(draft);
    if (Number.isFinite(numeric)) onCommit(property, numeric);
    else setDraft(String(Math.round(value)));
  };
  return (
    <input
      className={`box-value ${className}`}
      value={draft}
      inputMode="decimal"
      aria-label={`Edit ${property}`}
      title={`Edit ${property} in pixels`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        event.currentTarget.select();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(String(Math.round(value)));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function EditableDimensions({
  width,
  height,
  onCommit,
}: {
  width: number;
  height: number;
  onCommit: (property: string, value: number) => void;
}) {
  return (
    <span className="edit-beta-dimension-badge">
      <EditableBoundaryValue
        value={width}
        className="dimension-value"
        property="width"
        onCommit={onCommit}
      />
      <b>×</b>
      <EditableBoundaryValue
        value={height}
        className="dimension-value"
        property="height"
        onCommit={onCommit}
      />
      <em>px</em>
    </span>
  );
}

function cssColorHex(value: string) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value))
    return `#${value
      .slice(1)
      .split("")
      .map((char) => char + char)
      .join("")}`;
  const match = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!match) return "#000000";
  return `#${[match[1], match[2], match[3]]
    .map((part) =>
      Math.max(0, Math.min(255, Number(part)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function SelectionOverlay({
  selected,
  scale,
  boundaries,
  fontFamilies,
  onResize,
  onBoxChange,
  onTextStyle,
  onReorder,
  onAction,
  onAnnotate,
}: {
  selected: RemoteElement;
  scale: number;
  boundaries: Props["boundaries"];
  fontFamilies: string[];
  onResize: (
    values: { width?: string; height?: string },
    isFinal: boolean,
  ) => void;
  onBoxChange: (property: string, value: number) => void;
  onTextStyle: (values: Record<string, string>, isFinal?: boolean) => void;
  onReorder: (targetPath: string, placement: "before" | "after") => void;
  onAction: (action: "parent" | "up" | "down" | "duplicate" | "delete") => void;
  onAnnotate: () => void;
}) {
  const { rect, box } = selected;
  const [dragRect, setDragRect] = useState(rect);
  const draggingRef = useRef(false);
  const [moving, setMoving] = useState(false);
  const [moveOrigin, setMoveOrigin] = useState(rect);
  const [dropIndicator, setDropIndicator] = useState<{
    path: string;
    side: "top" | "right" | "bottom" | "left";
    placement: "before" | "after";
    rect: RemoteElement["rect"];
  } | null>(null);
  const [toolbarOffset, setToolbarOffset] = useState({ x: 0, y: 0 });
  const toolbarOffsetRef = useRef(toolbarOffset);
  useEffect(() => {
    if (!draggingRef.current) setDragRect(rect);
  }, [rect.height, rect.left, rect.top, rect.width, selected.path]);
  useEffect(() => {
    toolbarOffsetRef.current = { x: 0, y: 0 };
    setToolbarOffset({ x: 0, y: 0 });
  }, [selected.path]);
  const startToolbarMove = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = toolbarOffsetRef.current;
    let latest = origin;
    let frame = 0;
    try {
      target.setPointerCapture(pointerId);
    } catch {}
    const paint = () => {
      frame = 0;
      toolbarOffsetRef.current = latest;
      setToolbarOffset(latest);
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      latest = {
        x: origin.x + moveEvent.clientX - startX,
        y: origin.y + moveEvent.clientY - startY,
      };
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      move(finishEvent);
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      toolbarOffsetRef.current = latest;
      setToolbarOffset(latest);
      try {
        if (target.hasPointerCapture(pointerId))
          target.releasePointerCapture(pointerId);
      } catch {}
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  };
  const startResize = (
    event: React.PointerEvent<HTMLButtonElement>,
    horizontal: -1 | 0 | 1,
    vertical: -1 | 0 | 1,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      handle.setPointerCapture(pointerId);
    } catch {}
    const startX = event.clientX;
    const startY = event.clientY;
    let latest = { ...rect };
    let raf = 0;
    draggingRef.current = true;
    const values = () => ({
      ...(horizontal
        ? { width: `${Math.max(1, Math.round(latest.width))}px` }
        : {}),
      ...(vertical
        ? { height: `${Math.max(1, Math.round(latest.height))}px` }
        : {}),
    });
    const paint = () => {
      raf = 0;
      setDragRect({ ...latest });
      onResize(values(), false);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const dx = (moveEvent.clientX - startX) / scale;
      const dy = (moveEvent.clientY - startY) / scale;
      latest = {
        ...rect,
        width: Math.max(
          1,
          rect.width + (horizontal < 0 ? -dx : horizontal > 0 ? dx : 0),
        ),
        height: Math.max(
          1,
          rect.height + (vertical < 0 ? -dy : vertical > 0 ? dy : 0),
        ),
      };
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const cleanup = () => {
      draggingRef.current = false;
      try {
        if (handle.hasPointerCapture(pointerId))
          handle.releasePointerCapture(pointerId);
      } catch {}
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      handle.removeEventListener("lostpointercapture", onLostCapture);
    };
    const finish = (upEvent?: PointerEvent) => {
      if (!draggingRef.current) return;
      if (upEvent && upEvent.pointerId === pointerId) onMove(upEvent);
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      setDragRect({ ...latest });
      onResize(values(), true);
      cleanup();
    };
    const onUp = (upEvent: PointerEvent) => finish(upEvent);
    const onCancel = () => finish();
    const onLostCapture = () => finish();
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    handle.addEventListener("lostpointercapture", onLostCapture);
  };
  const handles: Array<[string, -1 | 0 | 1, -1 | 0 | 1]> = [
    ["nw", -1, -1],
    ["n", 0, -1],
    ["ne", 1, -1],
    ["e", 1, 0],
    ["se", 1, 1],
    ["s", 0, 1],
    ["sw", -1, 1],
    ["w", -1, 0],
  ];
  const startMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      handle.setPointerCapture(pointerId);
    } catch {}
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { ...rect };
    let latest = { ...origin };
    let latestDrop: typeof dropIndicator = null;
    let raf = 0;
    draggingRef.current = true;
    setMoving(true);
    setMoveOrigin(origin);
    setDropIndicator(null);
    const findDrop = (x: number, y: number) => {
      let best: {
        item: RemoteElement["siblings"][number];
        distance: number;
      } | null = null;
      for (const item of selected.siblings) {
        const r = item.rect;
        const dx =
          x < r.left
            ? r.left - x
            : x > r.left + r.width
              ? x - r.left - r.width
              : 0;
        const dy =
          y < r.top
            ? r.top - y
            : y > r.top + r.height
              ? y - r.top - r.height
              : 0;
        const distance = Math.hypot(dx, dy);
        if (!best || distance < best.distance) best = { item, distance };
      }
      if (
        !best ||
        best.distance >
          Math.max(64, Math.min(best.item.rect.width, best.item.rect.height))
      )
        return null;
      const target = best.item.rect;
      const horizontalLayout =
        Math.abs(
          target.left + target.width / 2 - (origin.left + origin.width / 2),
        ) >=
        Math.abs(
          target.top + target.height / 2 - (origin.top + origin.height / 2),
        );
      const edges = (
        horizontalLayout
          ? [
              {
                side: "left" as const,
                distance: Math.abs(x - target.left),
                placement: "before" as const,
              },
              {
                side: "right" as const,
                distance: Math.abs(x - target.left - target.width),
                placement: "after" as const,
              },
            ]
          : [
              {
                side: "top" as const,
                distance: Math.abs(y - target.top),
                placement: "before" as const,
              },
              {
                side: "bottom" as const,
                distance: Math.abs(y - target.top - target.height),
                placement: "after" as const,
              },
            ]
      ).sort((a, b) => a.distance - b.distance);
      return {
        path: best.item.path,
        side: edges[0].side,
        placement: edges[0].placement,
        rect: target,
      };
    };
    const paint = () => {
      raf = 0;
      setDragRect({ ...latest });
      setDropIndicator(latestDrop);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const dx = (moveEvent.clientX - startX) / scale;
      const dy = (moveEvent.clientY - startY) / scale;
      const parent = selected.parentRect;
      const unclampedLeft = origin.left + dx;
      const unclampedTop = origin.top + dy;
      latest = parent
        ? {
            ...origin,
            left: Math.max(
              parent.left,
              Math.min(
                parent.left + parent.width - origin.width,
                unclampedLeft,
              ),
            ),
            top: Math.max(
              parent.top,
              Math.min(
                parent.top + parent.height - origin.height,
                unclampedTop,
              ),
            ),
          }
        : { ...origin };
      latestDrop = findDrop(
        latest.left + latest.width / 2,
        latest.top + latest.height / 2,
      );
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const cleanup = () => {
      draggingRef.current = false;
      setMoving(false);
      setDropIndicator(null);
      try {
        if (handle.hasPointerCapture(pointerId))
          handle.releasePointerCapture(pointerId);
      } catch {}
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      handle.removeEventListener("lostpointercapture", onLostCapture);
    };
    const finish = (upEvent?: PointerEvent) => {
      if (!draggingRef.current) return;
      if (upEvent && upEvent.pointerId === pointerId) onMove(upEvent);
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (latestDrop) onReorder(latestDrop.path, latestDrop.placement);
      setDragRect(origin);
      cleanup();
    };
    const onUp = (upEvent: PointerEvent) => finish(upEvent);
    const onCancel = () => finish();
    const onLostCapture = () => finish();
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    handle.addEventListener("lostpointercapture", onLostCapture);
  };
  const positiveMargin = {
    top: Math.max(0, box.marginTop),
    right: Math.max(0, box.marginRight),
    bottom: Math.max(0, box.marginBottom),
    left: Math.max(0, box.marginLeft),
  };
  const marginBands = [
    {
      left: (dragRect.left - positiveMargin.left) * scale,
      top: (dragRect.top - positiveMargin.top) * scale,
      width: (dragRect.width + positiveMargin.left + positiveMargin.right) * scale,
      height: positiveMargin.top * scale,
    },
    {
      left: (dragRect.left + dragRect.width) * scale,
      top: dragRect.top * scale,
      width: positiveMargin.right * scale,
      height: dragRect.height * scale,
    },
    {
      left: (dragRect.left - positiveMargin.left) * scale,
      top: (dragRect.top + dragRect.height) * scale,
      width: (dragRect.width + positiveMargin.left + positiveMargin.right) * scale,
      height: positiveMargin.bottom * scale,
    },
    {
      left: (dragRect.left - positiveMargin.left) * scale,
      top: dragRect.top * scale,
      width: positiveMargin.left * scale,
      height: dragRect.height * scale,
    },
  ].filter((style) => style.width > 0 && style.height > 0);
  return (
    <>
      {moving && (
        <>
          <div
            className="edit-beta-move-origin"
            style={{
              left: moveOrigin.left * scale,
              top: moveOrigin.top * scale,
              width: moveOrigin.width * scale,
              height: moveOrigin.height * scale,
            }}
          />
          {dropIndicator && (
            <div
              className={`edit-beta-drop-target side-${dropIndicator.side}`}
              style={{
                left: dropIndicator.rect.left * scale,
                top: dropIndicator.rect.top * scale,
                width: dropIndicator.rect.width * scale,
                height: dropIndicator.rect.height * scale,
              }}
            >
              <span>
                {dropIndicator.placement === "before"
                  ? "Insert before"
                  : "Insert after"}
              </span>
            </div>
          )}
        </>
      )}
      {boundaries.enabled && boundaries.showMargins && (
        <>
          {marginBands.map((style, index) => (
            <i key={index} className="edit-beta-box-margin" style={style} />
          ))}
        </>
      )}
      <div
        className="edit-beta-selection-box"
        style={{
          left: dragRect.left * scale,
          top: dragRect.top * scale,
          width: dragRect.width * scale,
          height: dragRect.height * scale,
        }}
      >
        {boundaries.enabled && boundaries.showPaddings && (
          <>
            <i
              className="box-padding top"
              style={{ height: box.paddingTop * scale }}
            />
            <i
              className="box-padding right"
              style={{ width: box.paddingRight * scale }}
            />
            <i
              className="box-padding bottom"
              style={{ height: box.paddingBottom * scale }}
            />
            <i
              className="box-padding left"
              style={{ width: box.paddingLeft * scale }}
            />
          </>
        )}
        {handles.map(([name, horizontal, vertical]) => (
          <button
            key={name}
            className={`edit-beta-anchor ${name}`}
            onPointerDown={(event) => startResize(event, horizontal, vertical)}
            aria-label={`Resize ${name}`}
          />
        ))}
        <button
          className="edit-beta-move-handle"
          onPointerDown={startMove}
          title="Move element"
          aria-label="Move selected element"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2v20M2 12h20" />
            <path d="m8 6 4-4 4 4M8 18l4 4 4-4M6 8l-4 4 4 4M18 8l4 4-4 4" />
          </svg>
        </button>
        {boundaries.enabled && boundaries.showDimensions && (
          <EditableDimensions
            width={dragRect.width}
            height={dragRect.height}
            onCommit={onBoxChange}
          />
        )}
        {boundaries.enabled && boundaries.showMargins && (
          <>
            {box.marginTop !== 0 && (
              <EditableBoundaryValue
                value={box.marginTop}
                className="margin-top"
                property="margin-top"
                onCommit={onBoxChange}
              />
            )}
            {box.marginRight !== 0 && (
              <EditableBoundaryValue
                value={box.marginRight}
                className="margin-right"
                property="margin-right"
                onCommit={onBoxChange}
              />
            )}
            {box.marginBottom !== 0 && (
              <EditableBoundaryValue
                value={box.marginBottom}
                className="margin-bottom"
                property="margin-bottom"
                onCommit={onBoxChange}
              />
            )}
            {box.marginLeft !== 0 && (
              <EditableBoundaryValue
                value={box.marginLeft}
                className="margin-left"
                property="margin-left"
                onCommit={onBoxChange}
              />
            )}
          </>
        )}
        {boundaries.enabled && boundaries.showPaddings && (
          <>
            {box.paddingTop !== 0 && (
              <EditableBoundaryValue
                value={box.paddingTop}
                className="padding-top"
                property="padding-top"
                onCommit={onBoxChange}
              />
            )}
            {box.paddingRight !== 0 && (
              <EditableBoundaryValue
                value={box.paddingRight}
                className="padding-right"
                property="padding-right"
                onCommit={onBoxChange}
              />
            )}
            {box.paddingBottom !== 0 && (
              <EditableBoundaryValue
                value={box.paddingBottom}
                className="padding-bottom"
                property="padding-bottom"
                onCommit={onBoxChange}
              />
            )}
            {box.paddingLeft !== 0 && (
              <EditableBoundaryValue
                value={box.paddingLeft}
                className="padding-left"
                property="padding-left"
                onCommit={onBoxChange}
              />
            )}
          </>
        )}
        <div
          className="edit-beta-selection-toolbar"
          style={{
            transform: `translate(${toolbarOffset.x}px, ${toolbarOffset.y}px)`,
          }}
        >
          <div className="edit-beta-selection-toolbar-main">
            <strong
              className="edit-beta-toolbar-tag"
              onPointerDown={startToolbarMove}
              title="Drag toolbar"
            >
              {selected.tag}
            </strong>
            <button
              className="edit-beta-toolbar-grip"
              onPointerDown={startMove}
              title="Move the selected element"
              aria-label="Move the selected element"
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="8" cy="6" r="1.5" />
                <circle cx="16" cy="6" r="1.5" />
                <circle cx="8" cy="12" r="1.5" />
                <circle cx="16" cy="12" r="1.5" />
                <circle cx="8" cy="18" r="1.5" />
                <circle cx="16" cy="18" r="1.5" />
              </svg>
            </button>
            <span className="edit-beta-toolbar-divider" />
            <button
              onClick={() => onAction("parent")}
              title="Select parent"
              aria-label="Select parent"
            >
              <svg viewBox="0 0 24 24">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
            <button
              onClick={() => onAction("up")}
              title="Move element up"
              aria-label="Move element up"
            >
              <svg viewBox="0 0 24 24">
                <path d="m18 15-6-6-6 6" />
              </svg>
            </button>
            <button
              onClick={() => onAction("down")}
              title="Move element down"
              aria-label="Move element down"
            >
              <svg viewBox="0 0 24 24">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <button
              onClick={() => onAction("duplicate")}
              title="Duplicate element"
              aria-label="Duplicate element"
            >
              <svg viewBox="0 0 24 24">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
            <button
              className="edit-beta-toolbar-annotate"
              onClick={onAnnotate}
              title="Annotate this element"
              aria-label="Annotate this element"
            >
              <svg viewBox="0 0 24 24">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
            <button
              className="danger"
              onClick={() => onAction("delete")}
              title="Delete element"
              aria-label="Delete element"
            >
              <svg viewBox="0 0 24 24">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
          {selected.textEditable && (
            <div
              className="edit-beta-text-toolbar"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <select
                value={selected.styles["font-family"]
                  .split(",")[0]
                  .replace(/["']/g, "")
                  .trim()}
                onChange={(event) =>
                  onTextStyle({ "font-family": `"${event.target.value}"` })
                }
                title="Font family"
                aria-label="Font family"
              >
                {Array.from(
                  new Set([
                    selected.styles["font-family"]
                      .split(",")[0]
                      .replace(/["']/g, "")
                      .trim(),
                    ...fontFamilies,
                    "Arial",
                    "Georgia",
                    "Times New Roman",
                    "Verdana",
                  ]),
                )
                  .filter(Boolean)
                  .map((family) => (
                    <option key={family} value={family}>
                      {family}
                    </option>
                  ))}
              </select>
              <select
                value={
                  selected.styles["font-style"] === "italic"
                    ? "italic"
                    : selected.styles["font-weight"] === "normal"
                      ? "400"
                      : selected.styles["font-weight"] === "bold"
                        ? "700"
                        : selected.styles["font-weight"] || "400"
                }
                onChange={(event) =>
                  onTextStyle(
                    event.target.value === "italic"
                      ? { "font-style": "italic" }
                      : {
                          "font-style": "normal",
                          "font-weight": event.target.value,
                        },
                  )
                }
                title="Font style"
                aria-label="Font style"
              >
                <option value="300">Light</option>
                <option value="400">Regular</option>
                <option value="500">Medium</option>
                <option value="600">Semibold</option>
                <option value="700">Bold</option>
                <option value="italic">Italic</option>
              </select>
              <label className="edit-beta-font-size" title="Font size">
                <input
                  key={`${selected.path}-${selected.styles["font-size"]}`}
                  type="number"
                  min="1"
                  max="500"
                  defaultValue={Math.round(
                    parseFloat(selected.styles["font-size"]) || 16,
                  )}
                  onBlur={(event) =>
                    onTextStyle({
                      "font-size": `${Math.max(1, Number(event.target.value) || 1)}px`,
                    })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <span>px</span>
              </label>
              <span
                className="edit-beta-text-align"
                role="group"
                aria-label="Text alignment"
              >
                {(["left", "center", "right", "justify"] as const).map(
                  (alignment) => (
                    <button
                      key={alignment}
                      className={
                        selected.styles["text-align"] === alignment
                          ? "active"
                          : ""
                      }
                      onClick={() => onTextStyle({ "text-align": alignment })}
                      title={`Align ${alignment}`}
                      aria-label={`Align ${alignment}`}
                    >
                      <svg viewBox="0 0 24 24">
                        {alignment === "left" && (
                          <path d="M4 6h16M4 10h11M4 14h16M4 18h9" />
                        )}
                        {alignment === "center" && (
                          <path d="M4 6h16M7 10h10M4 14h16M8 18h8" />
                        )}
                        {alignment === "right" && (
                          <path d="M4 6h16M9 10h11M4 14h16M11 18h9" />
                        )}
                        {alignment === "justify" && (
                          <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                        )}
                      </svg>
                    </button>
                  ),
                )}
              </span>
              <SmoothColorPicker
                compact
                title="Text color"
                value={cssColorHex(selected.styles.color)}
                onPreview={(color) => onTextStyle({ color }, false)}
                onCommit={(color) => onTextStyle({ color }, true)}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const EditBetaWorkspace = forwardRef<EditBetaWorkspaceHandle, Props>(
  function EditBetaWorkspace(
    {
      sourceUrl,
      width,
      height,
      zoom,
      interactionMode,
      revealAnimations,
      fontInspectorMode,
      hotkeys,
      annotateMode = false,
      boundaries,
      leftPanelOpen,
      rightPanelOpen,
      rulersOn,
      guidesOn,
      guidesAlwaysVisible,
      guides,
      viewportMode,
      onViewportResize,
      overlayImage,
      overlayVisible,
      overlayOpacity = 50,
      overlayMode = "overlay",
      overlayLabel,
      figmaImage,
      figmaUrl = "",
      figmaViewMode = "live",
      figmaPanelVisible = false,
      snapshotImage,
      snapshotLabel = "Site Snapshot",
      onFigmaViewModeChange,
      onOpenFigmaSettings,
      onCloseFigmaPanel,
      onCloseSnapshotPanel,
      onThumbnailCaptured,
      canvasViewMode = "single",
      activeFrames = [],
      activeFrameId,
      onSelectActiveFrame,
      onToggleFrameEnabled,
      onRemoveFrame,
      annotations = [],
      activeAnnotationViewport,
      selectedAnnotationId,
      onSelectAnnotation,
      onAnnotateElement,
      onCanvasZoom,
      onHotkeyCommand,
      onEyedropperColorChange,
      accentColor = "#3b82f6",
    },
    ref,
  ) {
    const webviewRef = useRef<any>(null);
    const webviewsMapRef = useRef<Record<string, any>>({});
    const figmaWebviewRef = useRef<any>(null);
    const canvasRef = useRef<HTMLElement>(null);
    const viewportResizeCleanupRef = useRef<(() => void) | null>(null);
    const panRef = useRef({ x: 0, y: 0 });
    const bridgePanRef = useRef({
      active: false,
      startX: 0,
      startY: 0,
      startPanX: 0,
      startPanY: 0,
      lastSequence: 0,
    });
    const resizePreviewPendingRef = useRef<Record<string, string>>({});
    const resizePreviewTimerRef = useRef<number | null>(null);
    const resizePreviewInFlightRef = useRef<Promise<void> | null>(null);
    const resizeCommitChainRef = useRef<Promise<void>>(Promise.resolve());
    const panelResizeFrameRef = useRef<number | null>(null);
    const panelDragRef = useRef<{
      side: "left" | "right";
      pointerId: number;
      startX: number;
      startWidth: number;
    } | null>(null);
    const sectionResizeFrameRef = useRef<number | null>(null);
    const sectionDragRef = useRef<{
      divider: "annotations" | "layers" | "styles";
      pointerId: number;
      startY: number;
      annotationsHeight: number;
      layersHeight: number;
      stylesHeight: number;
    } | null>(null);
    const layerRowsRef = useRef(new Map<string, HTMLDivElement>());
    const cssPreviewTimerRef = useRef<number | null>(null);
    const cssCommitTimerRef = useRef<number | null>(null);
    const thumbnailCaptureStartedRef = useRef(false);
    const cssEditingPathRef = useRef("");
    const cssDraftRef = useRef("");
    const spacePressedRef = useRef(false);
    const patchesRef = useRef<any[]>([]);
    const patchStorageKeyRef = useRef("");
    const modeRef = useRef<InteractionMode>(interactionMode);
    const optionsRef = useRef<BridgeOptions>({
      revealAnimations,
      fontInspectorMode,
      hotkeys,
      annotateMode,
      boundaries,
      rulers: {
        enabled: rulersOn,
        guidesEnabled: guidesOn || guidesAlwaysVisible,
        guides,
      },
      zoomScale: Math.max(0.25, zoom / 100),
      accentColor,
    });
    const selectedStateKeyRef = useRef("");
    const historyStateKeyRef = useRef("");
    const [ready, setReady] = useState(false);
    const [mode, setMode] = useState<InteractionMode>(interactionMode);
    const [selected, setSelected] = useState<RemoteElement | null>(null);
    const [layers, setLayers] = useState<LayerRow[]>([]);
    const [history, setHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [url, setUrl] = useState(sourceUrl);
    const [textDraft, setTextDraft] = useState("");
    const [styleDrafts, setStyleDrafts] = useState<Record<string, string>>({});
    const [attrName, setAttrName] = useState("");
    const [attrValue, setAttrValue] = useState("");
    const [classDraft, setClassDraft] = useState("");
    const [cssDraft, setCssDraft] = useState("");
    const [collapsedLayers, setCollapsedLayers] = useState<Set<string>>(
      new Set(),
    );
    const [leftSections, setLeftSections] = useState({
      annotations: true,
      layers: true,
      styles: true,
      history: true,
    });
    const [annotationsSectionHeight, setAnnotationsSectionHeight] = useState(
      () =>
        Math.max(
          132,
          Math.min(
            560,
            Number(localStorage.getItem("qa_edit_annotations_height")) || 250,
          ),
        ),
    );
    const [layersSectionHeight, setLayersSectionHeight] = useState(
      () => Number(localStorage.getItem("qa_edit_layers_height")) || 340,
    );
    const [stylesSectionHeight, setStylesSectionHeight] = useState(
      () => Number(localStorage.getItem("qa_edit_styles_height")) || 260,
    );
    const annotationsSectionHeightRef = useRef(annotationsSectionHeight);
    const layersSectionHeightRef = useRef(layersSectionHeight);
    const stylesSectionHeightRef = useRef(stylesSectionHeight);
    const [pageColors, setPageColors] = useState<PaletteColor[]>([]);
    const [pageFonts, setPageFonts] = useState<PaletteFont[]>([]);
    const [selectedColors, setSelectedColors] = useState<Set<string>>(
      new Set(),
    );
    const [selectedFonts, setSelectedFonts] = useState<Set<string>>(new Set());
    const [colorsOpen, setColorsOpen] = useState(true);
    const [fontsOpen, setFontsOpen] = useState(true);
    const [leftPanelWidth, setLeftPanelWidth] = useState(() =>
      Math.max(
        210,
        Math.min(
          480,
          Number(localStorage.getItem("qa_edit_beta_left_width")) || 260,
        ),
      ),
    );
    const [rightPanelWidth, setRightPanelWidth] = useState(() =>
      Math.max(
        270,
        Math.min(
          480,
          Number(localStorage.getItem("qa_edit_beta_right_width")) || 300,
        ),
      ),
    );
    const [resizingPanel, setResizingPanel] = useState<"left" | "right" | null>(
      null,
    );
    const leftPanelWidthRef = useRef(leftPanelWidth);
    const rightPanelWidthRef = useRef(rightPanelWidth);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [panning, setPanning] = useState(false);
    const [figmaFrameOffset, setFigmaFrameOffset] = useState({ x: 0, y: 0 });
    const [liveFrameOffset, setLiveFrameOffset] = useState({ x: 0, y: 0 });
    const [snapshotFrameOffset, setSnapshotFrameOffset] = useState({ x: 0, y: 0 });
    const [capturePreviewDataUrl, setCapturePreviewDataUrl] = useState<string | null>(null);

    const annotationGroups = useMemo(() => {
      const groups = new Map<
        string,
        {
          key: string;
          name: string;
          width: number;
          height: number;
          deviceType: string;
          annotations: CanvasSelectionBox[];
        }
      >();
      activeFrames.forEach((frame) => {
        const key = `${Math.round(frame.width)}x${Math.round(frame.height)}`;
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            name: frame.name,
            width: Math.round(frame.width),
            height: Math.round(frame.height),
            deviceType: frame.deviceType,
            annotations: [],
          });
        }
      });
      if (activeAnnotationViewport && !groups.has(activeAnnotationViewport.key)) {
        groups.set(activeAnnotationViewport.key, {
          key: activeAnnotationViewport.key,
          name: activeAnnotationViewport.name,
          width: activeAnnotationViewport.width,
          height: activeAnnotationViewport.height,
          deviceType: activeAnnotationViewport.deviceType,
          annotations: [],
        });
      }
      annotations.forEach((annotation) => {
        const width = Math.round(annotation.viewportWidth || 0);
        const height = Math.round(annotation.viewportHeight || 0);
        const key = annotation.viewportKey || `${width}x${height}`;
        const existing = groups.get(key) || {
          key,
          name: annotation.deviceName || "Custom",
          width,
          height,
          deviceType: annotation.deviceType || "custom",
          annotations: [],
        };
        existing.annotations.push(annotation);
        groups.set(key, existing);
      });
      return Array.from(groups.values()).sort((a, b) => b.width - a.width);
    }, [activeAnnotationViewport, activeFrames, annotations]);
    const [frameSnapGuide, setFrameSnapGuide] = useState<{
      x: number | null;
      y: number | null;
      active: boolean;
    }>({ x: null, y: null, active: false });
    const [pageScrollY, setPageScrollY] = useState(0);
    const resetPan = useCallback(() => {
      panRef.current = { x: 0, y: 0 };
      bridgePanRef.current.active = false;
      setPanning(false);
      setPan({ x: 0, y: 0 });
    }, []);
    const viewportGeometry = canvasViewportGeometry(width, height, zoom);
    const scale = viewportGeometry.scale;
    const comparisonVisible = !!overlayImage && !!overlayVisible;
    const sideBySide = !!overlayVisible && overlayMode === "side-by-side";
    const figmaSideVisible =
      sideBySide && figmaPanelVisible && !!(figmaUrl || figmaImage);
    const snapshotSideVisible = sideBySide && !!snapshotImage;
    const scaledWidth = viewportGeometry.displayedWidth;
    const scaledHeight = viewportGeometry.displayedHeight;
    const siteOffsetX = figmaSideVisible ? scaledWidth + 24 : 0;
    const stageWidth =
      scaledWidth *
        (1 + Number(figmaSideVisible) + Number(snapshotSideVisible)) +
      24 * (Number(figmaSideVisible) + Number(snapshotSideVisible));
    const figmaFrameLeft = 0 + figmaFrameOffset.x * scale;
    const figmaFrameTop = 0 + figmaFrameOffset.y * scale;
    const liveFrameLeft = siteOffsetX + liveFrameOffset.x * scale;
    const liveFrameTop = 0 + liveFrameOffset.y * scale;
    const snapshotFrameLeft =
      siteOffsetX + scaledWidth + 24 + snapshotFrameOffset.x * scale;
    const snapshotFrameTop = 0 + snapshotFrameOffset.y * scale;

    const topRulerRef = useRef<HTMLCanvasElement | null>(null);
    const leftRulerRef = useRef<HTMLCanvasElement | null>(null);
    const liveFrameRef = useRef<HTMLDivElement | null>(null);
    const activeViewportRef = useRef<HTMLDivElement | null>(null);
    const [multiFrameOffsets, setMultiFrameOffsets] = useState<Record<string, { x: number; y: number }>>({});

    const [localGuides, setLocalGuides] = useState<
      Array<{ id: string; axis: "x" | "y"; position: number }>
    >([]);

    const drawCanvasRulers = useCallback(() => {
      if (!rulersOn) return;
      const topCanvas = topRulerRef.current;
      const leftCanvas = leftRulerRef.current;
      const canvasContainer = canvasRef.current;
      if (!topCanvas || !leftCanvas || !canvasContainer) return;

      const rect = canvasContainer.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      const topWidth = Math.max(10, rect.width - 24);
      const topHeight = 24;
      topCanvas.width = topWidth * dpr;
      topCanvas.height = topHeight * dpr;
      topCanvas.style.width = `${topWidth}px`;
      topCanvas.style.height = `${topHeight}px`;

      const leftWidth = 24;
      const leftHeight = Math.max(10, rect.height - 24);
      leftCanvas.width = leftWidth * dpr;
      leftCanvas.height = leftHeight * dpr;
      leftCanvas.style.width = `${leftWidth}px`;
      leftCanvas.style.height = `${leftHeight}px`;

      const liveRect = liveFrameRef.current?.getBoundingClientRect();
      const liveStageLeft = liveRect ? liveRect.left - rect.left - 24 : (28 + pan.x + liveFrameLeft - 24);
      const liveStageTop = liveRect ? liveRect.top - rect.top - 24 : (44 + pan.y + liveFrameTop - 24);

      // 1. Draw Top Ruler
      const ctxT = topCanvas.getContext("2d");
      if (ctxT) {
        ctxT.scale(dpr, dpr);
        ctxT.fillStyle = "#18181b";
        ctxT.fillRect(0, 0, topWidth, topHeight);

        ctxT.strokeStyle = "#3f3f46";
        ctxT.lineWidth = 1;
        ctxT.beginPath();
        ctxT.moveTo(0, topHeight - 0.5);
        ctxT.lineTo(topWidth, topHeight - 0.5);
        ctxT.stroke();

        ctxT.fillStyle = "#a1a1aa";
        ctxT.font = "9px Inter, monospace";
        ctxT.textAlign = "left";
        ctxT.textBaseline = "top";
        ctxT.strokeStyle = "#52525b";

        const step = 50 * scale;
        const minUnit = step < 20 ? 100 : step < 40 ? 50 : 25;
        const pixelStep = minUnit * scale;

        const startNum = Math.floor((-liveStageLeft) / pixelStep) * minUnit;
        const endNum = Math.ceil((topWidth - liveStageLeft) / pixelStep) * minUnit;

        for (let num = startNum; num <= endNum; num += minUnit) {
          const x = liveStageLeft + num * scale;
          if (x < 0 || x > topWidth) continue;

          const isMajor = num % 100 === 0;
          const tickH = isMajor ? 10 : 5;

          ctxT.beginPath();
          ctxT.moveTo(Math.floor(x) + 0.5, topHeight);
          ctxT.lineTo(Math.floor(x) + 0.5, topHeight - tickH);
          ctxT.stroke();

          if (isMajor && x + 25 < topWidth) {
            ctxT.fillText(String(num), Math.floor(x) + 3, 3);
          }
        }

        // Draw MS Word style downward pointing triangles for vertical guides (axis === "y")
        if (guidesOn || guidesAlwaysVisible) {
          const allGuides = [...guides, ...localGuides];
          allGuides.forEach((g) => {
            if (g.axis === "y") {
              const x = liveStageLeft + g.position * width * scale;
              if (x >= 0 && x <= topWidth) {
                ctxT.fillStyle = "#38bdf8";
                ctxT.beginPath();
                ctxT.moveTo(x - 5, topHeight - 9);
                ctxT.lineTo(x + 5, topHeight - 9);
                ctxT.lineTo(x, topHeight - 1);
                ctxT.closePath();
                ctxT.fill();
                ctxT.strokeStyle = "#1d4ed8";
                ctxT.lineWidth = 1;
                ctxT.stroke();
              }
            }
          });
        }
      }

      // 2. Draw Left Ruler
      const ctxL = leftCanvas.getContext("2d");
      if (ctxL) {
        ctxL.scale(dpr, dpr);
        ctxL.fillStyle = "#18181b";
        ctxL.fillRect(0, 0, leftWidth, leftHeight);

        ctxL.strokeStyle = "#3f3f46";
        ctxL.lineWidth = 1;
        ctxL.beginPath();
        ctxL.moveTo(leftWidth - 0.5, 0);
        ctxL.lineTo(leftWidth - 0.5, leftHeight);
        ctxL.stroke();

        ctxL.fillStyle = "#a1a1aa";
        ctxL.font = "9px Inter, monospace";
        ctxL.strokeStyle = "#52525b";

        const step = 50 * scale;
        const minUnit = step < 20 ? 100 : step < 40 ? 50 : 25;
        const pixelStep = minUnit * scale;

        const startNum = Math.floor((-liveStageTop) / pixelStep) * minUnit;
        const endNum = Math.ceil((leftHeight - liveStageTop) / pixelStep) * minUnit;

        for (let num = startNum; num <= endNum; num += minUnit) {
          const y = liveStageTop + num * scale;
          if (y < 0 || y > leftHeight) continue;

          const isMajor = num % 100 === 0;
          const tickW = isMajor ? 10 : 5;

          ctxL.beginPath();
          ctxL.moveTo(leftWidth, Math.floor(y) + 0.5);
          ctxL.lineTo(leftWidth - tickW, Math.floor(y) + 0.5);
          ctxL.stroke();

          if (isMajor && y + 25 < leftHeight) {
            ctxL.save();
            ctxL.translate(3, Math.floor(y) + 3);
            ctxL.rotate(-Math.PI / 2);
            ctxL.textAlign = "right";
            ctxL.textBaseline = "top";
            ctxL.fillText(String(num), 0, 0);
            ctxL.restore();
          }
        }

        // Draw MS Word style rightward pointing triangles for horizontal guides (axis === "x")
        if (guidesOn || guidesAlwaysVisible) {
          const allGuides = [...guides, ...localGuides];
          allGuides.forEach((g) => {
            if (g.axis === "x") {
              const y = liveStageTop + g.position * height * scale;
              if (y >= 0 && y <= leftHeight) {
                ctxL.fillStyle = "#38bdf8";
                ctxL.beginPath();
                ctxL.moveTo(leftWidth - 9, y - 5);
                ctxL.lineTo(leftWidth - 9, y + 5);
                ctxL.lineTo(leftWidth - 1, y);
                ctxL.closePath();
                ctxL.fill();
                ctxL.strokeStyle = "#1d4ed8";
                ctxL.lineWidth = 1;
                ctxL.stroke();
              }
            }
          });
        }
      }
    }, [
      rulersOn,
      pan,
      scale,
      liveFrameLeft,
      liveFrameTop,
      guides,
      localGuides,
      guidesOn,
      guidesAlwaysVisible,
      width,
      height,
    ]);

    useEffect(() => {
      if (!rulersOn) return;
      drawCanvasRulers();
      const el = canvasRef.current;
      if (!el) return;
      const ro = new ResizeObserver(() => drawCanvasRulers());
      ro.observe(el);
      return () => ro.disconnect();
    }, [rulersOn, drawCanvasRulers]);


    const [draggingRulerGuide, setDraggingRulerGuide] = useState<{
      id?: string;
      axis: "x" | "y";
      screenX: number;
      screenY: number;
      canvasPx: number;
      positionRatio: number;
    } | null>(null);
    const [hoveredGuideInfo, setHoveredGuideInfo] = useState<{
      axis: "x" | "y";
      px: number;
      screenX: number;
      screenY: number;
    } | null>(null);

    const calcGuidePos = useCallback(
      (axis: "x" | "y", moveX: number, moveY: number) => {
        const liveRect = liveFrameRef.current?.getBoundingClientRect();
        if (axis === "x") {
          const topEdge = liveRect ? liveRect.top : 44 + pan.y + liveFrameTop;
          const relY = moveY - topEdge;
          const px = Math.round(relY / scale);
          const ratio = relY / (height * scale);
          return { px, ratio };
        } else {
          const leftEdge = liveRect ? liveRect.left : 28 + pan.x + liveFrameLeft;
          const relX = moveX - leftEdge;
          const px = Math.round(relX / scale);
          const ratio = relX / (width * scale);
          return { px, ratio };
        }
      },
      [pan, liveFrameLeft, liveFrameTop, scale, height, width],
    );

    const beginRulerGuideDrag = (
      axis: "x" | "y",
      event: React.PointerEvent<HTMLCanvasElement>,
    ) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}

      const startX = event.clientX;
      const startY = event.clientY;
      const initial = calcGuidePos(axis, startX, startY);

      setDraggingRulerGuide({
        axis,
        screenX: startX,
        screenY: startY,
        canvasPx: initial.px,
        positionRatio: initial.ratio,
      });

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const pos = calcGuidePos(axis, moveEvent.clientX, moveEvent.clientY);
        setDraggingRulerGuide({
          axis,
          screenX: moveEvent.clientX,
          screenY: moveEvent.clientY,
          canvasPx: pos.px,
          positionRatio: pos.ratio,
        });
      };

      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== event.pointerId) return;
        const pos = calcGuidePos(axis, upEvent.clientX, upEvent.clientY);
        const liveRect = liveFrameRef.current?.getBoundingClientRect();
        const canvasRect = canvasRef.current?.getBoundingClientRect();

        let isDiscarded = false;
        if (axis === "x") {
          if (
            (liveRect && upEvent.clientY < liveRect.top) ||
            (canvasRect && upEvent.clientX < canvasRect.left + 24) ||
            pos.ratio < -0.15 ||
            pos.ratio > 1.25
          ) {
            isDiscarded = true;
          }
        } else {
          if (
            (liveRect && upEvent.clientX < liveRect.left) ||
            (canvasRect && upEvent.clientY < canvasRect.top + 24) ||
            pos.ratio < -0.15 ||
            pos.ratio > 1.25
          ) {
            isDiscarded = true;
          }
        }

        if (!isDiscarded) {
          const newId = `guide-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          setLocalGuides((prev) => [
            ...prev,
            { id: newId, axis, position: pos.ratio },
          ]);
        }

        setDraggingRulerGuide(null);
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onUp, true);
      };

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
    };

    const beginExistingGuideDrag = (
      guideId: string,
      axis: "x" | "y",
      event: React.PointerEvent<HTMLDivElement>,
    ) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}

      setLocalGuides((prev) => prev.filter((g) => g.id !== guideId));

      const startX = event.clientX;
      const startY = event.clientY;
      const initial = calcGuidePos(axis, startX, startY);

      setDraggingRulerGuide({
        id: guideId,
        axis,
        screenX: startX,
        screenY: startY,
        canvasPx: initial.px,
        positionRatio: initial.ratio,
      });

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const pos = calcGuidePos(axis, moveEvent.clientX, moveEvent.clientY);
        setDraggingRulerGuide({
          id: guideId,
          axis,
          screenX: moveEvent.clientX,
          screenY: moveEvent.clientY,
          canvasPx: pos.px,
          positionRatio: pos.ratio,
        });
      };

      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== event.pointerId) return;
        const pos = calcGuidePos(axis, upEvent.clientX, upEvent.clientY);
        const liveRect = liveFrameRef.current?.getBoundingClientRect();
        const canvasRect = canvasRef.current?.getBoundingClientRect();

        let isDiscarded = false;
        if (axis === "x") {
          if (
            (liveRect && upEvent.clientY < liveRect.top) ||
            (canvasRect && upEvent.clientX < canvasRect.left + 24) ||
            pos.ratio < -0.15 ||
            pos.ratio > 1.25
          ) {
            isDiscarded = true;
          }
        } else {
          if (
            (liveRect && upEvent.clientX < liveRect.left) ||
            (canvasRect && upEvent.clientY < canvasRect.top + 24) ||
            pos.ratio < -0.15 ||
            pos.ratio > 1.25
          ) {
            isDiscarded = true;
          }
        }

        if (!isDiscarded) {
          setLocalGuides((prev) => [
            ...prev,
            { id: guideId, axis, position: pos.ratio },
          ]);
        }

        setDraggingRulerGuide(null);
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onUp, true);
      };

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
    };



    const beginPanelResize = useCallback(
      (event: React.PointerEvent<HTMLDivElement>, side: "left" | "right") => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        panelDragRef.current = {
          side,
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth:
            side === "left"
              ? leftPanelWidthRef.current
              : rightPanelWidthRef.current,
        };
        setResizingPanel(side);
      },
      [],
    );

    const movePanelResize = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = panelDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const delta =
          (event.clientX - drag.startX) * (drag.side === "left" ? 1 : -1);
        const width = Math.round(
          Math.max(
            drag.side === "left" ? 210 : 270,
            Math.min(480, drag.startWidth + delta),
          ),
        );
        if (drag.side === "left") leftPanelWidthRef.current = width;
        else rightPanelWidthRef.current = width;
        if (panelResizeFrameRef.current != null)
          cancelAnimationFrame(panelResizeFrameRef.current);
        panelResizeFrameRef.current = requestAnimationFrame(() => {
          panelResizeFrameRef.current = null;
          drag.side === "left"
            ? setLeftPanelWidth(width)
            : setRightPanelWidth(width);
        });
      },
      [],
    );

    const endPanelResize = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = panelDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {}
        const width =
          drag.side === "left"
            ? leftPanelWidthRef.current
            : rightPanelWidthRef.current;
        drag.side === "left"
          ? setLeftPanelWidth(width)
          : setRightPanelWidth(width);
        localStorage.setItem(
          drag.side === "left"
            ? "qa_edit_beta_left_width"
            : "qa_edit_beta_right_width",
          String(width),
        );
        panelDragRef.current = null;
        setResizingPanel(null);
      },
      [],
    );

    const beginSectionResize = useCallback(
      (
        event: React.PointerEvent<HTMLDivElement>,
        divider: "annotations" | "layers" | "styles",
      ) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setLeftSections((current) => {
          if (divider === "annotations")
            return { ...current, annotations: true, layers: true };
          if (divider === "layers")
            return { ...current, layers: true, styles: true };
          return { ...current, styles: true, history: true };
        });
        sectionDragRef.current = {
          divider,
          pointerId: event.pointerId,
          startY: event.clientY,
          annotationsHeight: annotationsSectionHeightRef.current,
          layersHeight: layersSectionHeightRef.current,
          stylesHeight: stylesSectionHeightRef.current,
        };
      },
      [],
    );

    const moveSectionResize = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = sectionDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const delta = event.clientY - drag.startY;
        let nextAnnotations = drag.annotationsHeight;
        let nextLayers = drag.layersHeight;
        let nextStyles = drag.stylesHeight;
        if (drag.divider === "annotations") {
          const total = drag.annotationsHeight + drag.layersHeight;
          nextAnnotations = Math.max(
            132,
            Math.min(total - 150, drag.annotationsHeight + delta),
          );
          nextLayers = total - nextAnnotations;
        } else if (drag.divider === "layers") {
          const total = drag.layersHeight + drag.stylesHeight;
          nextLayers = Math.max(
            120,
            Math.min(total - 120, drag.layersHeight + delta),
          );
          nextStyles = total - nextLayers;
        } else {
          nextStyles = Math.max(120, Math.min(560, drag.stylesHeight + delta));
        }
        annotationsSectionHeightRef.current = Math.round(nextAnnotations);
        layersSectionHeightRef.current = Math.round(nextLayers);
        stylesSectionHeightRef.current = Math.round(nextStyles);
        if (sectionResizeFrameRef.current != null)
          cancelAnimationFrame(sectionResizeFrameRef.current);
        sectionResizeFrameRef.current = requestAnimationFrame(() => {
          sectionResizeFrameRef.current = null;
          setAnnotationsSectionHeight(annotationsSectionHeightRef.current);
          setLayersSectionHeight(layersSectionHeightRef.current);
          setStylesSectionHeight(stylesSectionHeightRef.current);
        });
      },
      [],
    );

    const endSectionResize = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = sectionDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {}
        setAnnotationsSectionHeight(annotationsSectionHeightRef.current);
        setLayersSectionHeight(layersSectionHeightRef.current);
        setStylesSectionHeight(stylesSectionHeightRef.current);
        localStorage.setItem(
          "qa_edit_annotations_height",
          String(annotationsSectionHeightRef.current),
        );
        localStorage.setItem(
          "qa_edit_layers_height",
          String(layersSectionHeightRef.current),
        );
        localStorage.setItem(
          "qa_edit_styles_height",
          String(stylesSectionHeightRef.current),
        );
        sectionDragRef.current = null;
      },
      [],
    );

    const constrainPan = useCallback(
      (x: number, y: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return { x, y };
        const currentScale = Math.max(0.25, zoom / 100);
        const hasFigmaSide =
          !!overlayVisible &&
          overlayMode === "side-by-side" &&
          figmaPanelVisible &&
          !!(figmaUrl || figmaImage);
        const hasSnapshotSide =
          !!overlayVisible && overlayMode === "side-by-side" && !!snapshotImage;
        const sideCount = Number(hasFigmaSide) + Number(hasSnapshotSide);
        const stageWidth =
          width * currentScale * (1 + sideCount) + 24 * sideCount;
        const stageHeight = height * currentScale;
        const visibleEdge = Math.min(
          120,
          canvas.clientWidth / 3,
          canvas.clientHeight / 3,
        );
        const limitX = Math.max(
          0,
          (canvas.clientWidth + stageWidth) / 2 - visibleEdge,
        );
        const minY = visibleEdge - 28 - stageHeight;
        const maxY = canvas.clientHeight - visibleEdge - 28;
        return {
          x: Math.max(-limitX, Math.min(limitX, x)),
          y: Math.max(minY, Math.min(maxY, y)),
        };
      },
      [
        figmaImage,
        figmaPanelVisible,
        figmaUrl,
        height,
        overlayMode,
        overlayVisible,
        snapshotImage,
        width,
        zoom,
      ],
    );

    const execute = useCallback(async (expression: string) => {
      const view = webviewRef.current || Object.values(webviewsMapRef.current)[0];
      if (!view || typeof view.executeJavaScript !== "function") return null;
      try {
        return await view.executeJavaScript(expression, true);
      } catch {
        return null;
      }
    }, []);

    const executeAll = useCallback(async (expression: string) => {
      const views = Object.values(webviewsMapRef.current).filter(Boolean);
      if (views.length === 0) return execute(expression);
      const results = await Promise.all(
        views.map(async (view) => {
          try {
            if (view && typeof view.executeJavaScript === "function") {
              return await view.executeJavaScript(expression, true);
            }
          } catch {
            return null;
          }
        })
      );
      return results[0];
    }, [execute]);

    const deselect = useCallback(async () => {
      await executeAll(
        "window.__fullForceEditBeta?.deselect?.() || false",
      );
      selectedStateKeyRef.current = JSON.stringify(null);
      setSelected(null);
      try {
        window.getSelection()?.removeAllRanges();
      } catch {}
    }, [executeAll]);

    const captureProjectThumbnail = useCallback(async () => {
      const view = webviewRef.current;
      if (
        !onThumbnailCaptured ||
        thumbnailCaptureStartedRef.current ||
        !view ||
        typeof view.capturePage !== "function"
      )
        return;
      thumbnailCaptureStartedRef.current = true;
      try {
        const state = await view.executeJavaScript(
          `(async () => {
        const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        try { await Promise.race([document.fonts?.ready || Promise.resolve(), wait(1200)]); } catch {}
        try {
          const images = Array.from(document.images || []).filter(img => !img.complete).slice(0, 20);
          await Promise.race([Promise.all(images.map(img => new Promise(resolve => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); }))), wait(1200)]);
        } catch {}
        window.scrollTo(0, 0);
        await wait(120);
        return { href: location.href, title: document.title || '', hasPassword: !!document.querySelector('input[type="password"]'), bodyLength: (document.body?.innerText || '').trim().length };
      })()`,
          true,
        );
        const href = String(state?.href || "").toLowerCase();
        const title = String(state?.title || "").toLowerCase();
        if (
          !state ||
          href.includes("wp-login.php") ||
          (state.hasPassword && href.includes("wp-admin")) ||
          title.includes("404") ||
          title.includes("page not found") ||
          Number(state.bodyLength || 0) < 20
        ) {
          thumbnailCaptureStartedRef.current = false;
          return;
        }
        const image = await view.capturePage();
        if (!image || typeof image.resize !== "function")
          throw new Error("Thumbnail capture returned no image");
        const size =
          typeof image.getSize === "function"
            ? image.getSize()
            : { width: 0, height: 0 };
        const targetWidth = 480;
        const targetHeight =
          size.width > 0 && size.height > 0
            ? Math.max(
                180,
                Math.min(
                  320,
                  Math.round((size.height * targetWidth) / size.width),
                ),
              )
            : 270;
        const resized = image.resize({
          width: targetWidth,
          height: targetHeight,
          quality: "good",
        });
        const dataUrl = resized.toDataURL();
        if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/"))
          onThumbnailCaptured(dataUrl);
      } catch {
        thumbnailCaptureStartedRef.current = false;
      }
    }, [onThumbnailCaptured]);

    const hardReload = useCallback(async () => {
      try {
        await window.electronAPI?.clearCache?.();
      } catch {}
      const view = webviewRef.current;
      if (!view) return;
      try {
        if (typeof view.reloadIgnoringCache === "function")
          view.reloadIgnoringCache();
        else view.reload?.();
      } catch {
        try {
          view.reload?.();
        } catch {}
      }
    }, []);

    const refreshLayers = useCallback(async () => {
      const result = await execute(
        "window.__fullForceEditBeta?.getLayers() || []",
      );
      if (Array.isArray(result)) setLayers(result);
    }, [execute]);

    const install = useCallback(async () => {
      const pageUrl = webviewRef.current?.getURL?.() || sourceUrl;
      patchStorageKeyRef.current = `fullforce_edit_beta_patches:${pageUrl}`;
      try {
        const saved = sessionStorage.getItem(patchStorageKeyRef.current);
        patchesRef.current = saved ? JSON.parse(saved) : [];
      } catch {
        patchesRef.current = [];
      }
      const ok = await execute(`(${installEditBetaBridge.toString()})()`);
      if (!ok) return;
      if (patchesRef.current.length)
        await execute(
          `window.__fullForceEditBeta.applyPatches(${JSON.stringify(patchesRef.current)})`,
        );
      await execute(
        `window.__fullForceEditBeta.setMode(${JSON.stringify(modeRef.current)})`,
      );
      await execute(
        `window.__fullForceEditBeta.setOptions(${JSON.stringify(optionsRef.current)})`,
      );
      setReady(true);
      void refreshLayers();
    }, [execute, refreshLayers, sourceUrl]);

    useEffect(() => {
      const cleanups: Array<() => void> = [];

      const bindWebview = (frameId: string, view: any) => {
        if (!view) return;
        let lastZoomSequence = 0;

        const onLoad = async () => {
          setReady(false);
          try {
            // Canvas zoom belongs to the host transform. Keep the guest at 1x
            // so its backing surface always matches the requested viewport.
            view.setZoomFactor?.(1);
          } catch {}
          try {
            const currentUrl = typeof view.getURL === "function" ? view.getURL() : "";
            if (currentUrl && (frameId === activeFrameId || !activeFrameId)) setUrl(currentUrl);
          } catch {}

          const pageUrl = (typeof view.getURL === "function" ? view.getURL() : "") || sourceUrl;
          patchStorageKeyRef.current = `fullforce_edit_beta_patches:${pageUrl}`;
          try {
            const saved = sessionStorage.getItem(patchStorageKeyRef.current);
            patchesRef.current = saved ? JSON.parse(saved) : [];
          } catch {
            patchesRef.current = [];
          }

          try {
            const ok = await view.executeJavaScript(`(${installEditBetaBridge.toString()})()`, true);
            if (ok) {
              await view.executeJavaScript(`window.__fullForceFrameId = ${JSON.stringify(frameId)}`, true);
              if (patchesRef.current.length) {
                await view.executeJavaScript(`window.__fullForceEditBeta.applyPatches(${JSON.stringify(patchesRef.current)})`, true);
              }
              await view.executeJavaScript(`window.__fullForceEditBeta.setMode(${JSON.stringify(modeRef.current)})`, true);
              await view.executeJavaScript(`window.__fullForceEditBeta.setOptions(${JSON.stringify(optionsRef.current)})`, true);
            }
          } catch {}
          setReady(true);
          void refreshLayers();
        };

        const onNavigate = (event: any) => {
          if (event.url && (frameId === activeFrameId || !activeFrameId)) setUrl(event.url);
        };

        const onFinishedLoad = () => {
          if (frameId === activeFrameId || !activeFrameId) {
            window.setTimeout(() => void captureProjectThumbnail(), 180);
          }
        };

        const onConsoleMessage = (event: any) => {
          const message = String(event.message || "");
          if (message.startsWith("__FULLFORCE_ZOOM__")) {
            event.preventDefault?.();
            try {
              const payload = JSON.parse(
                message.slice("__FULLFORCE_ZOOM__".length),
              );
              const sequence = Number(payload.sequence || 0);
              const deltaY = Number(payload.deltaY || 0);
              if (sequence <= lastZoomSequence || !deltaY) return;
              lastZoomSequence = sequence;
              onCanvasZoom?.(deltaY);
            } catch {}
            return;
          }
          if (message.startsWith("__FULLFORCE_FRAME_CLICK__")) {
            const clickedId = message.slice("__FULLFORCE_FRAME_CLICK__".length).trim();
            if (clickedId && onSelectActiveFrame && canvasViewMode === "multi") {
              onSelectActiveFrame(clickedId);
            }
            return;
          }
          if (message.startsWith("__FULLFORCE_HOTKEY__")) {
            event.preventDefault?.();
            const command = message.slice("__FULLFORCE_HOTKEY__".length).trim() as keyof AppHotkeys;
            if (command && Object.prototype.hasOwnProperty.call(optionsRef.current.hotkeys, command)) {
              onHotkeyCommand?.(command);
            }
            return;
          }
          if (message.startsWith("__FULLFORCE_EYEDROPPER__")) {
            event.preventDefault?.();
            try {
              const sample = JSON.parse(message.slice("__FULLFORCE_EYEDROPPER__".length));
              onEyedropperColorChange?.(
                sample && typeof sample.hex === "string" ? sample as EyedropperSample : null,
              );
            } catch {
              onEyedropperColorChange?.(null);
            }
            return;
          }
          if (!message.startsWith("__FULLFORCE_PAN__")) return;
          event.preventDefault?.();
          try {
            const payload = JSON.parse(message.slice("__FULLFORCE_PAN__".length));
            const session = bridgePanRef.current;
            const sequence = Number(payload.sequence || 0);
            if (sequence <= session.lastSequence) return;
            session.lastSequence = sequence;
            if (payload.active && !session.active) {
              session.active = true;
              session.startX = Number(payload.screenX || 0);
              session.startY = Number(payload.screenY || 0);
              session.startPanX = panRef.current.x;
              session.startPanY = panRef.current.y;
              setPanning(true);
            } else if (payload.active && session.active) {
              const next = constrainPan(
                session.startPanX + Number(payload.screenX || 0) - session.startX,
                session.startPanY + Number(payload.screenY || 0) - session.startY,
              );
              panRef.current = next;
              setPan(next);
            } else {
              session.active = false;
              setPanning(false);
            }
          } catch {}
        };

        view.addEventListener("dom-ready", onLoad);
        view.addEventListener("did-finish-load", onFinishedLoad);
        view.addEventListener("did-navigate", onNavigate);
        view.addEventListener("did-navigate-in-page", onNavigate);
        view.addEventListener("console-message", onConsoleMessage);

        try {
          if (typeof view.getURL === "function" && view.getURL()) {
            void onLoad();
          }
        } catch {}

        cleanups.push(() => {
          try {
            view.removeEventListener("dom-ready", onLoad);
            view.removeEventListener("did-finish-load", onFinishedLoad);
            view.removeEventListener("did-navigate", onNavigate);
            view.removeEventListener("did-navigate-in-page", onNavigate);
            view.removeEventListener("console-message", onConsoleMessage);
          } catch {}
        });
      };

      Object.entries(webviewsMapRef.current).forEach(([frameId, view]) => {
        bindWebview(frameId, view);
      });

      return () => {
        cleanups.forEach((c) => c());
      };
    }, [activeFrameId, activeFrames, captureProjectThumbnail, canvasViewMode, constrainPan, onCanvasZoom, onEyedropperColorChange, onHotkeyCommand, onSelectActiveFrame, refreshLayers, sourceUrl]);

    useEffect(() => {
      // Also normalize already-mounted guests after hot reloads or canvas zoom
      // changes; older builds may have left them at the canvas scale.
      Object.values(webviewsMapRef.current).forEach((view) => {
        try {
          view?.setZoomFactor?.(1);
        } catch {}
      });
    }, [scale]);

    useEffect(() => {
      if (!ready) return;
      const timer = window.setInterval(async () => {
        const state = (await execute(
          "window.__fullForceEditBeta?.getState() || null",
        )) as BridgeState | null;
        if (!state) return;
        const selectedKey = JSON.stringify(state.selected);
        if (selectedKey !== selectedStateKeyRef.current) {
          selectedStateKeyRef.current = selectedKey;
          setSelected(state.selected);
        }
        const historyKey = JSON.stringify([state.history, state.historyIndex]);
        if (historyKey !== historyStateKeyRef.current) {
          historyStateKeyRef.current = historyKey;
          setHistory(state.history || []);
          setHistoryIndex(state.historyIndex ?? -1);
        }
        patchesRef.current = state.patches || patchesRef.current;
        setPageScrollY(state.scrollY || 0);
        try {
          sessionStorage.setItem(
            patchStorageKeyRef.current,
            JSON.stringify(patchesRef.current),
          );
        } catch {}
      }, 250);
      return () => window.clearInterval(timer);
    }, [execute, ready]);

    useEffect(() => {
      const view = figmaWebviewRef.current;
      if (!view || !figmaSideVisible) return;
      const onNewWindow = (event: any) => {
        if (!event?.url) return;
        const loginWindow = (window.electronAPI as any)?.figmaLoginWindow;
        if (typeof loginWindow === "function") {
          void loginWindow(event.url).then(() => {
            try {
              view.reload?.();
            } catch {}
          });
        } else {
          void window.electronAPI?.openExternal?.(event.url);
        }
      };
      const onDomReady = () => {
        try {
          view.setZoomFactor?.(Math.max(0.2, Math.min(1, scale)));
        } catch {}
      };
      view.addEventListener("new-window", onNewWindow);
      view.addEventListener("dom-ready", onDomReady);
      onDomReady();
      return () => {
        try {
          view.removeEventListener("new-window", onNewWindow);
          view.removeEventListener("dom-ready", onDomReady);
        } catch {}
      };
    }, [figmaSideVisible, figmaUrl, scale]);

    useEffect(() => {
      modeRef.current = interactionMode;
      setMode(interactionMode);
      if (interactionMode !== "eyedropper") onEyedropperColorChange?.(null);
      if (ready)
        void execute(
          `window.__fullForceEditBeta?.setMode(${JSON.stringify(interactionMode)})`,
        );
    }, [execute, interactionMode, onEyedropperColorChange, ready]);

    useEffect(() => {
      resetPan();
    }, [resetPan, sourceUrl]);

    useEffect(() => {
      resetPan();
    }, [
      figmaSideVisible,
      leftPanelOpen,
      resetPan,
      rightPanelOpen,
      snapshotSideVisible,
    ]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || typeof ResizeObserver === "undefined") return;
      let frame = 0;
      const observer = new ResizeObserver(() => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = 0;
          const next = constrainPan(panRef.current.x, panRef.current.y);
          panRef.current = next;
          setPan(next);
        });
      });
      observer.observe(canvas);
      return () => {
        observer.disconnect();
        if (frame) cancelAnimationFrame(frame);
      };
    }, [constrainPan]);

    useEffect(() => {
      optionsRef.current = {
        revealAnimations,
        fontInspectorMode,
        hotkeys,
        annotateMode,
        boundaries,
        rulers: {
          enabled: rulersOn,
          guidesEnabled: guidesOn || guidesAlwaysVisible,
          guides: [...guides, ...localGuides],
        },
        zoomScale: Math.max(0.25, zoom / 100),
        accentColor,
      };
      if (ready)
        void execute(
          `window.__fullForceEditBeta?.setOptions(${JSON.stringify(optionsRef.current)})`,
        );
    }, [
      annotateMode,
      accentColor,
      boundaries,
      execute,
      fontInspectorMode,
      hotkeys,
      guides,
      guidesAlwaysVisible,
      guidesOn,
      localGuides,
      ready,
      revealAnimations,
      rulersOn,
      zoom,
    ]);

    useEffect(() => {
      if (selected?.path && cssEditingPathRef.current === selected.path) return;
      cssEditingPathRef.current = "";
      setTextDraft(selected?.text || "");
      setStyleDrafts(selected?.styles || {});
      setClassDraft(selected?.className || "");
      const nextCss = formatCssSource(selected?.cssSource || "");
      cssDraftRef.current = nextCss;
      setCssDraft(nextCss);
    }, [selected?.cssSource, selected?.path]);

    useEffect(
      () => () => {
        if (cssPreviewTimerRef.current != null)
          window.clearTimeout(cssPreviewTimerRef.current);
        if (cssCommitTimerRef.current != null)
          window.clearTimeout(cssCommitTimerRef.current);
      },
      [],
    );

    const call = async (method: string, ...args: any[]) => {
      const result = await executeAll(
        `window.__fullForceEditBeta?.[${JSON.stringify(method)}](...${JSON.stringify(args)})`,
      );
      if (["duplicate", "remove", "move", "undo", "redo", "applyPatches", "reorder", "commitStyle"].includes(method))
        void refreshLayers();
      return result;
    };
    const updateCssDraftLive = (value: string) => {
      setCssDraft(value);
      const path = selected?.path;
      if (!path) return;
      cssDraftRef.current = value;
      cssEditingPathRef.current = path;
      if (cssPreviewTimerRef.current != null)
        window.clearTimeout(cssPreviewTimerRef.current);
      if (cssCommitTimerRef.current != null)
        window.clearTimeout(cssCommitTimerRef.current);
      cssPreviewTimerRef.current = window.setTimeout(() => {
        cssPreviewTimerRef.current = null;
        void call("previewCssSource", value, path);
      }, 35);
      cssCommitTimerRef.current = window.setTimeout(() => {
        cssCommitTimerRef.current = null;
        void call("setCssSource", value, path).finally(() => {
          if (
            cssEditingPathRef.current === path &&
            cssDraftRef.current === value
          )
            cssEditingPathRef.current = "";
        });
      }, 650);
    };
    const flushResizePreview = () => {
      resizePreviewTimerRef.current = null;
      if (resizePreviewInFlightRef.current) return;
      const entries = Object.entries(resizePreviewPendingRef.current);
      if (!entries.length) return;
      resizePreviewPendingRef.current = {};
      resizePreviewInFlightRef.current = (async () => {
        for (const [property, value] of entries)
          await call("previewStyle", property, value);
      })().finally(() => {
        resizePreviewInFlightRef.current = null;
        if (
          Object.keys(resizePreviewPendingRef.current).length &&
          resizePreviewTimerRef.current == null
        ) {
          resizePreviewTimerRef.current = window.setTimeout(
            flushResizePreview,
            24,
          );
        }
      });
    };
    const handleElementDragStyle = (
      values: Record<string, string>,
      isFinal: boolean,
    ) => {
      setStyleDrafts((current) => ({ ...current, ...values }));
      resizePreviewPendingRef.current = {
        ...resizePreviewPendingRef.current,
        ...values,
      };
      if (!isFinal) {
        if (resizePreviewTimerRef.current == null)
          resizePreviewTimerRef.current = window.setTimeout(
            flushResizePreview,
            24,
          );
        return;
      }
      if (resizePreviewTimerRef.current != null) {
        window.clearTimeout(resizePreviewTimerRef.current);
        resizePreviewTimerRef.current = null;
      }
      const finalValues = { ...resizePreviewPendingRef.current, ...values };
      resizePreviewPendingRef.current = {};
      const activePreview = resizePreviewInFlightRef.current;
      resizeCommitChainRef.current = resizeCommitChainRef.current.then(
        async () => {
          if (activePreview) await activePreview;
          for (const [property, value] of Object.entries(finalValues))
            await call("setStyle", property, value);
        },
      );
    };
    const revertAllLocalEdits = useCallback(async () => {
      await execute("window.__fullForceEditBeta?.revertAll()");
      patchesRef.current = [];
      try {
        sessionStorage.removeItem(patchStorageKeyRef.current);
      } catch {}
      selectedStateKeyRef.current = "";
      historyStateKeyRef.current = "";
      setSelected(null);
      setHistory([]);
      setHistoryIndex(-1);
      setStyleDrafts({});
      setTextDraft("");
      void refreshLayers();
    }, [execute, refreshLayers]);

    useEffect(() => {
      if (!ready) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (
          (event.key === "Escape" || event.code === "Escape") &&
          mode === "edit" &&
          selected
        ) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          void deselect();
          return;
        }
        const target = event.target as HTMLElement | null;
        if (
          target?.closest?.('input,textarea,select,[contenteditable="true"]') ||
          !(event.ctrlKey || event.metaKey)
        )
          return;
        const key = event.key.toLowerCase();
        if (key === "z" && !event.shiftKey) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void call("undo");
        } else if (key === "y" || (key === "z" && event.shiftKey)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void call("redo");
        }
      };
      window.addEventListener("keydown", onKeyDown, true);
      return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [deselect, mode, ready, selected?.path]);
    const scanColors = useCallback(async () => {
      const result = await execute(
        "window.__fullForceEditBeta?.scanColors() || []",
      );
      if (Array.isArray(result)) setPageColors(result);
    }, [execute]);
    const scanFonts = useCallback(async () => {
      const result = await execute(
        "window.__fullForceEditBeta?.scanFonts() || []",
      );
      if (Array.isArray(result)) setPageFonts(result);
    }, [execute]);

    useEffect(() => {
      if (!ready || !rightPanelOpen) return;
      void scanColors();
      void scanFonts();
    }, [ready, rightPanelOpen, scanColors, scanFonts]);

    useEffect(() => {
      if (!ready) return;
      void execute(
        `window.__fullForceEditBeta?.highlightUsage('color', ${JSON.stringify(Array.from(selectedColors))})`,
      );
    }, [execute, ready, selectedColors]);

    useEffect(() => {
      if (!ready) return;
      if (selectedColors.size) return;
      void execute(
        `window.__fullForceEditBeta?.highlightUsage('font', ${JSON.stringify(Array.from(selectedFonts))})`,
      );
    }, [execute, ready, selectedColors.size, selectedFonts]);

    useImperativeHandle(
      ref,
      () => ({
        reload: () => {
          void hardReload();
        },
        deselect: () => {
          void deselect();
        },
        undo: () => {
          void call("undo");
        },
        redo: () => {
          void call("redo");
        },
        refreshLayers: () => {
          void refreshLayers();
        },
        captureViewport: async () => {
          const view = webviewRef.current;
          if (!view || typeof view.capturePage !== "function") return null;
          try {
            await execute("window.__fullForceEditBeta?.prepareCapture?.() || true");
            const image = await view.capturePage();
            if (!image) return null;
            const dataUrl = typeof image.toDataURL === "function" ? image.toDataURL() : null;
            return typeof dataUrl === "string" && dataUrl.startsWith("data:image/") ? dataUrl : null;
          } catch (err) {
            console.error("Error capturing viewport:", err);
            return null;
          } finally {
            await execute("window.__fullForceEditBeta?.finishCapture?.() || true");
          }
        },
        captureFullPage: async () => {
          const view = webviewRef.current as any;
          if (!view) return null;
          try {
            await rendererCaptureWithTimeout(
              execute("window.__fullForceEditBeta?.prepareCapture?.('metadata') || true"),
              5_000,
              "Timed out preparing the guest page for capture.",
            );
          } catch (error) {
            console.warn("Guest capture preparation did not complete:", error);
          }
          try {
            try {
              const previewImage = await rendererCaptureWithTimeout(
                view.capturePage(),
                5_000,
                "Timed out preparing the capture preview.",
              );
              const previewDataUrl = previewImage?.toDataURL?.();
              if (typeof previewDataUrl === "string" && previewDataUrl.startsWith("data:image/")) {
                setCapturePreviewDataUrl(previewDataUrl);
                await new Promise<void>((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                );
              }
            } catch (error) {
              console.warn("Unable to prepare the capture preview:", error);
            }

            const webContentsId = typeof view.getWebContentsId === "function" ? view.getWebContentsId() : null;
            if (webContentsId && window.electronAPI?.captureAutomatePage) {
              // The guest surface remains at its real responsive viewport
              // dimensions and only its host frame is visually transformed.
              // Reading offset dimensions preserves the v1.3.2/v1.3.3
              // capture contract and prevents Chromium from repeating a
              // smaller zoomed surface across a full-width screenshot.
              const viewportWidth = activeViewportRef.current?.offsetWidth || width || 1280;
              const viewportHeight = activeViewportRef.current?.offsetHeight || height || 800;
              const res = await rendererCaptureWithTimeout(
                window.electronAPI.captureAutomatePage(
                  webContentsId,
                  viewportWidth,
                  viewportHeight,
                ),
                68_000,
                "Full-page capture did not finish within 68 seconds.",
              );
              if (res?.success && res.dataUrl) return res.dataUrl;
              console.error("CDP full-page capture failed:", res?.error || "Unknown capture error");
              return null;
            }

            // Compatibility fallback for environments without the full-page
            // IPC bridge. Never use this when CDP reports a failure, because a
            // viewport image must not be presented as a full-site capture.
            const image = await view.capturePage();
            return image ? image.toDataURL() : null;
          } finally {
            try {
              await rendererCaptureWithTimeout(
                execute("window.__fullForceEditBeta?.finishCapture?.() || true"),
                5_000,
                "Timed out restoring the guest page after capture.",
              );
            } catch (error) {
              console.warn("Guest capture restoration did not complete:", error);
            } finally {
              setCapturePreviewDataUrl(null);
            }
          }
        },
        getScrollY: async () => {
          try {
            const res = await execute("window.scrollY || document.documentElement.scrollTop || 0");
            return typeof res === "number" ? res : 0;
          } catch (err) {
            return 0;
          }
        },
        scrollBy: (deltaY: number) => {
          const view = webviewRef.current as any;
          if (view && typeof view.executeJavaScript === "function") {
            view.executeJavaScript(`window.scrollBy({ top: ${deltaY}, behavior: "instant" })`);
          }
        },
        scrollTo: (top: number) => {
          const view = webviewRef.current as any;
          if (view && typeof view.executeJavaScript === "function") {
            view.executeJavaScript(
              `window.scrollTo({ top: ${Math.max(0, Number(top) || 0)}, behavior: "smooth" })`,
            );
          }
        },
        getViewportGeometry: () => {
          const viewport = activeViewportRef.current;
          if (!viewport) return null;
          const rect = viewport.getBoundingClientRect();
          return {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            pageWidth: width,
            pageHeight: height,
          };
        },
        getCaptureInspection: async () => {
          try {
            const result = await rendererCaptureWithTimeout(
              execute("window.__fullForceEditBeta?.getCaptureInspection?.() || []"),
              5_000,
              "Timed out reading capture inspection metadata.",
            );
            return Array.isArray(result) ? result : [];
          } catch (error) {
            console.warn("Capture inspection metadata was unavailable:", error);
            return [];
          }
        },
        getPatches: async () => {
          const result = await execute("window.__fullForceEditBeta?.getPatches() || []");
          return Array.isArray(result) ? result : [];
        },
      }),
      [deselect, execute, hardReload, height, refreshLayers, width],
    );
    const navigate = () => {
      let next = url.trim();
      if (!/^https?:\/\//i.test(next)) next = `https://${next}`;
      webviewRef.current?.loadURL?.(next);
    };
    const visibleLayers = layers.filter(
      (layer) =>
        !layer.ancestors.some((ancestor) => collapsedLayers.has(ancestor)),
    );
    const toggleLeftSection = (section: keyof typeof leftSections) =>
      setLeftSections((current) => ({
        ...current,
        [section]: !current[section],
      }));

    useEffect(() => {
      const path = selected?.path;
      if (!path || !leftSections.layers) return;
      const layer = layers.find((item) => item.path === path);
      if (!layer) return;
      if (layer.ancestors.some((ancestor) => collapsedLayers.has(ancestor))) {
        setCollapsedLayers((current) => {
          const next = new Set(current);
          layer.ancestors.forEach((ancestor) => next.delete(ancestor));
          return next;
        });
      }
      const frame = requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          layerRowsRef.current
            .get(path)
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
        }),
      );
      return () => cancelAnimationFrame(frame);
    }, [collapsedLayers, layers, leftSections.layers, selected?.path]);
    useEffect(
      () => () => {
        viewportResizeCleanupRef.current?.();
      },
      [],
    );

    const beginResize = (
      event: React.PointerEvent<HTMLButtonElement>,
      axis: "x" | "y" | "both",
    ) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      viewportResizeCleanupRef.current?.();

      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = width;
      const startHeight = height;
      let latestX = startX;
      let latestY = startY;
      let animationFrame = 0;
      let finished = false;

      const blockedSurfaces = Array.from(
        canvasRef.current?.querySelectorAll<HTMLElement>("iframe, webview") || [],
      ).map((element) => ({ element, pointerEvents: element.style.pointerEvents }));
      blockedSurfaces.forEach(({ element }) => {
        element.style.pointerEvents = "none";
      });

      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.classList.add("is-viewport-resizing");
      document.body.style.cursor =
        axis === "x" ? "ew-resize" : axis === "y" ? "ns-resize" : "nwse-resize";
      document.body.style.userSelect = "none";

      try {
        handle.setPointerCapture(pointerId);
      } catch {}

      const applyLatestSize = () => {
        animationFrame = 0;
        const nextWidth =
          axis === "y"
            ? startWidth
            : Math.max(
                100,
                Math.round(startWidth + (latestX - startX) / scale),
              );
        const nextHeight =
          axis === "x"
            ? startHeight
            : Math.max(
                100,
                Math.round(startHeight + (latestY - startY) / scale),
              );
        onViewportResize(nextWidth, nextHeight);
      };

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        latestX = moveEvent.clientX;
        latestY = moveEvent.clientY;
        if (!animationFrame)
          animationFrame = requestAnimationFrame(applyLatestSize);
      };

      const finish = (upEvent?: PointerEvent) => {
        if (finished || (upEvent && upEvent.pointerId !== pointerId)) return;
        finished = true;
        if (upEvent) {
          latestX = upEvent.clientX;
          latestY = upEvent.clientY;
        }
        if (animationFrame) cancelAnimationFrame(animationFrame);
        applyLatestSize();
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", finish, true);
        window.removeEventListener("blur", onBlur);
        try {
          if (handle.hasPointerCapture(pointerId))
            handle.releasePointerCapture(pointerId);
        } catch {}
        blockedSurfaces.forEach(({ element, pointerEvents }) => {
          element.style.pointerEvents = pointerEvents;
        });
        document.body.classList.remove("is-viewport-resizing");
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        if (viewportResizeCleanupRef.current === cleanup)
          viewportResizeCleanupRef.current = null;
      };

      const cleanup = () => finish();
      const onBlur = () => finish();
      viewportResizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", finish, true);
      window.addEventListener("blur", onBlur);
    };
    const beginCanvasPan = (event: React.MouseEvent) => {
      if (
        interactionMode !== "edit" ||
        (event.button !== 1 && !(spacePressedRef.current && event.button === 0))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setPanning(true);
      let lastX = event.clientX;
      let lastY = event.clientY;
      const onMove = (moveEvent: MouseEvent) => {
        const next = constrainPan(
          panRef.current.x + moveEvent.clientX - lastX,
          panRef.current.y + moveEvent.clientY - lastY,
        );
        panRef.current = next;
        lastX = moveEvent.clientX;
        lastY = moveEvent.clientY;
        setPan(next);
      };
      const onUp = () => {
        setPanning(false);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };

    const frameDragRef = useRef<{
      frameType: "figma" | "live" | "snapshot";
      pointerId: number;
      startX: number;
      startY: number;
      startOffsetX: number;
      startOffsetY: number;
    } | null>(null);

    const beginMultiDeviceFrameDrag = useCallback(
      (frameId: string, event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest("button, input, select")) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {}

        const startX = event.clientX;
        const startY = event.clientY;
        const currentOffset = multiFrameOffsets[frameId] || { x: 0, y: 0 };
        const startOffsetX = currentOffset.x;
        const startOffsetY = currentOffset.y;

        document.body.style.cursor = "grabbing";

        const onMove = (moveEvent: PointerEvent) => {
          if (moveEvent.pointerId !== event.pointerId) return;
          const deltaX = (moveEvent.clientX - startX) / scale;
          const deltaY = (moveEvent.clientY - startY) / scale;
          setMultiFrameOffsets((prev) => ({
            ...prev,
            [frameId]: { x: startOffsetX + deltaX, y: startOffsetY + deltaY },
          }));
        };

        const onUp = (upEvent: PointerEvent) => {
          if (upEvent.pointerId !== event.pointerId) return;
          document.body.style.cursor = "default";
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {}
          window.removeEventListener("pointermove", onMove, true);
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onUp, true);
        };

        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onUp, true);
      },
      [multiFrameOffsets, scale]
    );

    const beginFrameDrag = useCallback(
      (
        frameType: "figma" | "live" | "snapshot",
        event: React.PointerEvent<HTMLDivElement>,
      ) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest("button, input, select"))
          return;
        event.preventDefault();
        event.stopPropagation();

        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {}

        const startX = event.clientX;
        const startY = event.clientY;
        const startOffset =
          frameType === "figma"
            ? figmaFrameOffset
            : frameType === "live"
              ? liveFrameOffset
              : snapshotFrameOffset;

        frameDragRef.current = {
          frameType,
          pointerId: event.pointerId,
          startX,
          startY,
          startOffsetX: startOffset.x,
          startOffsetY: startOffset.y,
        };

        document.body.style.cursor = "grabbing";

        const defaultFigmaLeft = 0;
        const defaultLiveLeft = figmaSideVisible ? scaledWidth + 24 : 0;
        const defaultSnapshotLeft = defaultLiveLeft + scaledWidth + 24;

        const getBaseLeft = (type: "figma" | "live" | "snapshot") =>
          type === "figma"
            ? defaultFigmaLeft
            : type === "live"
              ? defaultLiveLeft
              : defaultSnapshotLeft;

        const onMove = (moveEvent: PointerEvent) => {
          if (moveEvent.pointerId !== event.pointerId) return;
          const drag = frameDragRef.current;
          if (!drag) return;

          const deltaX = (moveEvent.clientX - drag.startX) / scale;
          const deltaY = (moveEvent.clientY - drag.startY) / scale;

          const rawOffsetX = drag.startOffsetX + deltaX;
          const rawOffsetY = drag.startOffsetY + deltaY;

          const baseLeft = getBaseLeft(drag.frameType);
          const rawLeft = baseLeft + rawOffsetX * scale;
          const rawTop = 0 + rawOffsetY * scale;

          const curFigmaLeft = defaultFigmaLeft + figmaFrameOffset.x * scale;
          const curLiveLeft = defaultLiveLeft + liveFrameOffset.x * scale;
          const curSnapshotLeft = defaultSnapshotLeft + snapshotFrameOffset.x * scale;

          const curFigmaTop = figmaFrameOffset.y * scale;
          const curLiveTop = liveFrameOffset.y * scale;
          const curSnapshotTop = snapshotFrameOffset.y * scale;

          const snapTargetsX: number[] = [
            0,
            defaultLiveLeft,
            defaultSnapshotLeft,
          ];
          const snapTargetsY: number[] = [0];

          if (drag.frameType !== "figma" && figmaSideVisible) {
            snapTargetsX.push(
              curFigmaLeft,
              curFigmaLeft + scaledWidth + 24,
              curFigmaLeft - scaledWidth - 24,
            );
            snapTargetsY.push(curFigmaTop);
          }
          if (drag.frameType !== "live") {
            snapTargetsX.push(
              curLiveLeft,
              curLiveLeft + scaledWidth + 24,
              curLiveLeft - scaledWidth - 24,
            );
            snapTargetsY.push(curLiveTop);
          }
          if (drag.frameType !== "snapshot" && snapshotSideVisible) {
            snapTargetsX.push(
              curSnapshotLeft,
              curSnapshotLeft + scaledWidth + 24,
              curSnapshotLeft - scaledWidth - 24,
            );
            snapTargetsY.push(curSnapshotTop);
          }

          const snapThreshold = 14;
          let snappedLeft: number | null = null;
          let closestDistX = snapThreshold + 1;

          for (const target of snapTargetsX) {
            const dist = Math.abs(rawLeft - target);
            if (dist <= snapThreshold && dist < closestDistX) {
              closestDistX = dist;
              snappedLeft = target;
            }
          }

          let snappedTop: number | null = null;
          let closestDistY = snapThreshold + 1;

          for (const target of snapTargetsY) {
            const dist = Math.abs(rawTop - target);
            if (dist <= snapThreshold && dist < closestDistY) {
              closestDistY = dist;
              snappedTop = target;
            }
          }

          const finalLeft = snappedLeft !== null ? snappedLeft : rawLeft;
          const finalTop = snappedTop !== null ? snappedTop : rawTop;

          if (snappedLeft !== null || snappedTop !== null) {
            setFrameSnapGuide({ x: snappedLeft, y: snappedTop, active: true });
          } else {
            setFrameSnapGuide({ x: null, y: null, active: false });
          }

          const finalOffsetX = (finalLeft - baseLeft) / scale;
          const finalOffsetY = finalTop / scale;

          if (drag.frameType === "figma")
            setFigmaFrameOffset({ x: finalOffsetX, y: finalOffsetY });
          else if (drag.frameType === "live")
            setLiveFrameOffset({ x: finalOffsetX, y: finalOffsetY });
          else if (drag.frameType === "snapshot")
            setSnapshotFrameOffset({ x: finalOffsetX, y: finalOffsetY });
        };

        const finishMove = (finishEvent: PointerEvent) => {
          if (finishEvent.pointerId !== event.pointerId) return;
          frameDragRef.current = null;
          setFrameSnapGuide({ x: null, y: null, active: false });
          document.body.style.cursor = "";
          window.removeEventListener("pointermove", onMove, true);
          window.removeEventListener("pointerup", finishMove, true);
          window.removeEventListener("pointercancel", finishMove, true);
        };

        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", finishMove, true);
        window.addEventListener("pointercancel", finishMove, true);
      },
      [
        figmaFrameOffset,
        liveFrameOffset,
        snapshotFrameOffset,
        figmaSideVisible,
        snapshotSideVisible,
        scaledWidth,
        scale,
      ],
    );

    useEffect(() => {
      const down = (event: KeyboardEvent) => {
        if (
          event.code === "Space" &&
          !(event.target as HTMLElement | null)?.closest?.(
            'input,textarea,select,[contenteditable="true"]',
          )
        )
          spacePressedRef.current = true;
      };
      const up = (event: KeyboardEvent) => {
        if (event.code === "Space") spacePressedRef.current = false;
      };
      window.addEventListener("keydown", down, true);
      window.addEventListener("keyup", up, true);
      return () => {
        window.removeEventListener("keydown", down, true);
        window.removeEventListener("keyup", up, true);
      };
    }, []);

    return (
      <div className="edit-beta-root">
        <div className="edit-beta-nav">
          <button onClick={() => webviewRef.current?.goBack?.()} title="Back">
            ←
          </button>
          <button
            onClick={() => webviewRef.current?.goForward?.()}
            title="Forward"
          >
            →
          </button>
          <button
            onClick={() => void hardReload()}
            title="Hard reload (bypass cache)"
          >
            ↻
          </button>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate();
            }}
          />
          <div className="edit-beta-nav-actions">
            <button
              className="edit-beta-nav-icon"
              disabled={historyIndex < 0}
              onClick={() => void call("undo")}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              <svg viewBox="0 0 24 24">
                <path d="M9 7H5v-4" />
                <path d="m5 7 4-4" />
                <path d="M5 7h8a7 7 0 0 1 7 7v1a6 6 0 0 1-6 6h-3" />
              </svg>
            </button>
            <button
              className="edit-beta-nav-icon"
              disabled={historyIndex + 1 >= history.length}
              onClick={() => void call("redo")}
              title="Redo (Ctrl+Y)"
              aria-label="Redo"
            >
              <svg viewBox="0 0 24 24">
                <path d="M15 7h4v-4" />
                <path d="m19 7-4-4" />
                <path d="M19 7h-8a7 7 0 0 0-7 7v1a6 6 0 0 0 6 6h3" />
              </svg>
            </button>
            <span className="edit-beta-nav-divider" />
            <button
              className="edit-beta-nav-icon danger"
              disabled={historyIndex < 0}
              onClick={() => void revertAllLocalEdits()}
              title="Revert all local changes"
              aria-label="Revert all local changes"
            >
              <svg viewBox="0 0 24 24">
                <path d="M4 4v6h6" />
                <path d="M5.5 9A8 8 0 1 1 4 15" />
                <path d="m9.5 13 5 5m0-5-5 5" />
              </svg>
            </button>
            <button
              className="edit-beta-nav-icon"
              onClick={resetPan}
              title="Center canvas"
              aria-label="Center canvas"
            >
              <svg viewBox="0 0 24 24">
                <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
                <circle cx="12" cy="12" r="3" />
                <path d="M12 7v2M12 15v2M7 12h2M15 12h2" />
              </svg>
            </button>
          </div>
        </div>

        <div
          className={`edit-beta-body ${resizingPanel ? "is-resizing-panel" : ""}`}
          style={{
            gridTemplateColumns: `${leftPanelOpen ? leftPanelWidth : 0}px minmax(0,1fr) ${rightPanelOpen ? rightPanelWidth : 0}px`,
          }}
        >
          <aside
            className={`edit-beta-left ${leftPanelOpen ? "is-open" : "is-collapsed"}`}
            aria-hidden={!leftPanelOpen}
          >
            <div
              className="edit-beta-panel-resizer edit-beta-panel-resizer-left"
              onPointerDown={(event) => beginPanelResize(event, "left")}
              onPointerMove={movePanelResize}
              onPointerUp={endPanelResize}
              onPointerCancel={endPanelResize}
            />
            <section
              className={`edit-beta-left-section annotations ${leftSections.annotations ? "open" : ""}`}
              style={
                leftSections.annotations
                  ? {
                      flex: `0 0 ${annotationsSectionHeight}px`,
                      height: annotationsSectionHeight,
                    }
                  : undefined
              }
            >
              <button
                className="edit-beta-left-heading"
                onClick={() => toggleLeftSection("annotations")}
              >
                <span>
                  <i>{leftSections.annotations ? "⌄" : "›"}</i> Annotations
                </span>
                <small>{annotations.length}</small>
              </button>
              {leftSections.annotations && (
                <div className="edit-beta-annotation-groups">
                  {annotationGroups.map((group) => {
                    const isActive = group.key === activeAnnotationViewport?.key;
                    return (
                      <div
                        key={group.key}
                        className={`edit-beta-annotation-device ${isActive ? "active" : ""}`}
                      >
                        <div className="edit-beta-annotation-device-head">
                          <span className={`edit-beta-device-icon ${group.deviceType}`} aria-hidden="true" />
                          <span>
                            <b>{group.name}</b>
                            <small>{group.width} × {group.height}</small>
                          </span>
                          <em>{isActive ? "Viewing" : group.annotations.length}</em>
                        </div>
                        {group.annotations.length > 0 ? (
                          <div className="edit-beta-annotation-items">
                            {group.annotations.map((annotation) => (
                              <button
                                key={annotation.id}
                                className={selectedAnnotationId === annotation.id ? "selected" : ""}
                                onClick={() => onSelectAnnotation?.(annotation)}
                                title={`Open #${annotation.badgeNumber} at ${group.width} × ${group.height}`}
                              >
                                <i style={{ background: annotation.color }} />
                                <span>
                                  <b>#{annotation.badgeNumber} {annotation.title}</b>
                                  <small>{plainTextFromRichText(annotation.notes) || "No notes"}</small>
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="edit-beta-annotation-empty">
                            No annotations at this size
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            <div
              className="edit-beta-section-resizer"
              onPointerDown={(event) => beginSectionResize(event, "annotations")}
              onPointerMove={moveSectionResize}
              onPointerUp={endSectionResize}
              onPointerCancel={endSectionResize}
              title="Drag to resize Annotations and Layers"
              aria-label="Resize Annotations section"
            />
            <section
              className={`edit-beta-left-section layers ${leftSections.layers ? "open" : ""}`}
              style={
                leftSections.layers
                  ? {
                      flex: `0 0 ${layersSectionHeight}px`,
                      height: layersSectionHeight,
                    }
                  : undefined
              }
            >
              <button
                className="edit-beta-left-heading"
                onClick={() => toggleLeftSection("layers")}
              >
                <span>
                  <i>{leftSections.layers ? "⌄" : "›"}</i> Layers
                </span>
                <small>{layers.length}</small>
              </button>
              {leftSections.layers && (
                <>
                  <div className="edit-beta-panel-tools">
                    <span>Live DOM</span>
                    <button
                      onClick={() => void refreshLayers()}
                      title="Refresh DOM tree"
                    >
                      ↻
                    </button>
                  </div>
                  <div className="edit-beta-tree">
                    {visibleLayers.map((layer, index) => (
                      <div
                        ref={(node) => {
                          if (node) layerRowsRef.current.set(layer.path, node);
                          else layerRowsRef.current.delete(layer.path);
                        }}
                        key={`${layer.path}-${index}`}
                        className={`edit-beta-layer-row ${selected?.path === layer.path ? "selected" : ""}`}
                        style={
                          {
                            paddingLeft: 6 + Math.min(layer.depth, 9) * 12,
                            "--layer-depth": Math.min(layer.depth, 9),
                          } as React.CSSProperties
                        }
                      >
                        {layer.hasChildren ? (
                          <button
                            className="edit-beta-layer-chevron"
                            onClick={() =>
                              setCollapsedLayers((current) => {
                                const next = new Set(current);
                                next.has(layer.path)
                                  ? next.delete(layer.path)
                                  : next.add(layer.path);
                                return next;
                              })
                            }
                          >
                            {collapsedLayers.has(layer.path) ? "›" : "⌄"}
                          </button>
                        ) : (
                          <span className="edit-beta-layer-spacer" />
                        )}
                        <button
                          className="edit-beta-layer-name"
                          onClick={() => void call("selectPath", layer.path)}
                          title={layer.path}
                        >
                          <b>{layer.tag}</b>
                          <span>{layer.label.slice(layer.tag.length)}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
            <div
              className="edit-beta-section-resizer"
              onPointerDown={(event) => beginSectionResize(event, "layers")}
              onPointerMove={moveSectionResize}
              onPointerUp={endSectionResize}
              onPointerCancel={endSectionResize}
              title="Drag to resize Layers and Styles"
            />
            <section
              className={`edit-beta-left-section styles ${leftSections.styles ? "open" : ""}`}
              style={
                leftSections.styles
                  ? {
                      flex: `0 0 ${stylesSectionHeight}px`,
                      height: stylesSectionHeight,
                    }
                  : undefined
              }
            >
              <button
                className="edit-beta-left-heading"
                onClick={() => toggleLeftSection("styles")}
              >
                <span>
                  <i>{leftSections.styles ? "⌄" : "›"}</i> Styles
                </span>
              </button>
              {leftSections.styles &&
                (selected ? (
                  <div className="edit-beta-css-editor">
                    <div className="edit-beta-css-selector">
                      {selected.tag}
                      {selected.id
                        ? `#${selected.id}`
                        : selected.className
                          ? `.${selected.className.trim().split(/\s+/).slice(0, 2).join(".")}`
                          : ""}
                    </div>
                    <div className="edit-beta-css-toolbar">
                      <span>CSS</span>
                      <i>Live</i>
                      <button
                        onClick={() =>
                          updateCssDraftLive(formatCssSource(cssDraft))
                        }
                        title="Format stylesheet"
                      >
                        Format
                      </button>
                      <em>Spaces: 2</em>
                    </div>
                    <div className="edit-beta-css-code">
                      <pre
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{
                          __html: highlightCssSource(cssDraft),
                        }}
                      />
                      <textarea
                        value={cssDraft}
                        wrap="off"
                        spellCheck={false}
                        onKeyDown={(event) => {
                          if (event.key !== "Tab") return;
                          event.preventDefault();
                          const target = event.currentTarget;
                          const start = target.selectionStart;
                          const end = target.selectionEnd;
                          const next = `${cssDraft.slice(0, start)}  ${cssDraft.slice(end)}`;
                          updateCssDraftLive(next);
                          requestAnimationFrame(() => {
                            target.selectionStart = target.selectionEnd =
                              start + 2;
                          });
                        }}
                        onScroll={(event) => {
                          const pre = event.currentTarget
                            .previousElementSibling as HTMLElement | null;
                          if (pre) {
                            pre.scrollTop = event.currentTarget.scrollTop;
                            pre.scrollLeft = event.currentTarget.scrollLeft;
                          }
                        }}
                        onChange={(event) =>
                          updateCssDraftLive(event.target.value)
                        }
                        placeholder={"selector {\n  margin: 0;\n}"}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="edit-beta-section-empty">
                    Select an element to edit its inline CSS.
                  </div>
                ))}
            </section>
            <div
              className="edit-beta-section-resizer"
              onPointerDown={(event) => beginSectionResize(event, "styles")}
              onPointerMove={moveSectionResize}
              onPointerUp={endSectionResize}
              onPointerCancel={endSectionResize}
              title="Drag to resize Styles and History"
            />
            <section
              className={`edit-beta-left-section history ${leftSections.history ? "open" : ""}`}
            >
              <button
                className="edit-beta-left-heading"
                onClick={() => toggleLeftSection("history")}
              >
                <span>
                  <i>{leftSections.history ? "⌄" : "›"}</i> History
                </span>
                <small>{history.length}</small>
              </button>
              {leftSections.history && (
                <div className="edit-beta-history-list">
                  <div
                    className={`edit-beta-history-entry initial ${historyIndex < 0 ? "current" : ""}`}
                  >
                    <i>○</i>
                    <span>
                      <b>Initial page</b>
                      <small>Unmodified local state</small>
                    </span>
                    {historyIndex < 0 && <em>Current</em>}
                  </div>
                  {history.map((item, index) => (
                    <div
                      key={`${item}-${index}`}
                      className={`edit-beta-history-entry ${index === historyIndex ? "current" : ""} ${index > historyIndex ? "future" : ""}`}
                    >
                      <i>{index > historyIndex ? "○" : "✓"}</i>
                      <span>
                        <b>{item}</b>
                        <small>
                          {index > historyIndex
                            ? "Undone change"
                            : "Local edit"}
                        </small>
                      </span>
                      {index === historyIndex && <em>Current</em>}
                    </div>
                  ))}
                </div>
              )}
            </section>
            <div className="edit-beta-panel-title">
              <span>Live DOM Layers</span>
              <button onClick={() => void refreshLayers()}>↻</button>
            </div>
            <div className="edit-beta-legacy-layers">
              {layers.map((layer, index) => (
                <button
                  key={`${layer.path}-${index}`}
                  className={selected?.path === layer.path ? "selected" : ""}
                  style={{ paddingLeft: 8 + Math.min(layer.depth, 7) * 12 }}
                  onClick={() => void call("selectPath", layer.path)}
                  title={layer.path}
                >
                  {layer.label}
                </button>
              ))}
            </div>
            <div className="edit-beta-panel-title">History</div>
            <div className="edit-beta-legacy-history">
              {history.length === 0 ? (
                <span>No edits yet</span>
              ) : (
                history.map((item, index) => (
                  <div
                    key={`${item}-${index}`}
                    className={
                      index === historyIndex
                        ? "current"
                        : index > historyIndex
                          ? "future"
                          : ""
                    }
                  >
                    {item}
                  </div>
                ))
              )}
            </div>
          </aside>

          <main
            ref={canvasRef}
            className={`edit-beta-canvas ${rulersOn ? "with-rulers" : ""} ${panning ? "is-panning" : ""} ${snapshotSideVisible ? "has-snapshot-side" : ""}`}
            onMouseDown={beginCanvasPan}
          >
            {rulersOn && (
              <div className="edit-beta-canvas-rulers">
                <div className="edit-beta-ruler-corner" />
                <canvas
                  ref={topRulerRef}
                  className="edit-beta-ruler-canvas-top"
                  onPointerDown={(e) => beginRulerGuideDrag("x", e)}
                  title="Drag down to create horizontal guide"
                />
                <canvas
                  ref={leftRulerRef}
                  className="edit-beta-ruler-canvas-left"
                  onPointerDown={(e) => beginRulerGuideDrag("y", e)}
                  title="Drag right to create vertical guide"
                />
              </div>
            )}
            {draggingRulerGuide && (
              <div className="edit-beta-ruler-drag-overlay">
                <div
                  className={`edit-beta-guide-drag-line edit-beta-guide-${draggingRulerGuide.axis === "x" ? "h" : "v"}`}
                  style={
                    draggingRulerGuide.axis === "x"
                      ? { top: `${draggingRulerGuide.screenY}px` }
                      : { left: `${draggingRulerGuide.screenX}px` }
                  }
                />
                <div
                  className="edit-beta-ruler-pixel-badge"
                  style={{
                    left: `${draggingRulerGuide.screenX}px`,
                    top: `${draggingRulerGuide.screenY}px`,
                  }}
                >
                  <span className="badge-axis">
                    {draggingRulerGuide.axis === "x" ? "Y:" : "X:"}
                  </span>
                  <span className="badge-value">{draggingRulerGuide.canvasPx}px</span>
                </div>
              </div>
            )}
            {!draggingRulerGuide && hoveredGuideInfo && (
              <div
                className="edit-beta-ruler-pixel-badge"
                style={{
                  left: `${hoveredGuideInfo.screenX}px`,
                  top: `${hoveredGuideInfo.screenY}px`,
                }}
              >
                <span className="badge-axis">
                  {hoveredGuideInfo.axis === "x" ? "Y:" : "X:"}
                </span>
                <span className="badge-value">{hoveredGuideInfo.px}px</span>
              </div>
            )}
            <div
              className="edit-beta-stage"
              style={{
                width: stageWidth,
                height: scaledHeight,
                transform: `translate(${pan.x}px, ${pan.y}px)`,
              }}
            >
              {figmaSideVisible && (
                <div
                  className="edit-beta-compare-frame edit-beta-compare-figma"
                  style={{ left: figmaFrameLeft, top: figmaFrameTop, width: scaledWidth, height: scaledHeight }}
                >
                  <div
                    className="edit-beta-compare-label"
                    onPointerDown={(event) => beginFrameDrag("figma", event)}
                  >
                    <span>
                      <img src={figmaIcon} alt="" />
                      Figma{" "}
                      {figmaUrl && figmaImage
                        ? "Design"
                        : figmaUrl
                          ? "Live App"
                          : "PNG Reference"}
                    </span>
                    {figmaUrl && figmaImage && (
                      <span className="edit-beta-compare-switch">
                        <button
                          className={figmaViewMode === "live" ? "active" : ""}
                          onClick={() => onFigmaViewModeChange?.("live")}
                        >
                          Live
                        </button>
                        <button
                          className={figmaViewMode === "png" ? "active" : ""}
                          onClick={() => onFigmaViewModeChange?.("png")}
                        >
                          PNG
                        </button>
                      </span>
                    )}
                    <span className="edit-beta-compare-actions">
                      <button
                        onClick={onOpenFigmaSettings}
                        title="Edit Figma source"
                      >
                        ⚙
                      </button>
                      <button
                        onClick={onCloseFigmaPanel}
                        title="Close Figma panel"
                      >
                        ×
                      </button>
                    </span>
                  </div>
                  {figmaUrl && (figmaViewMode === "live" || !figmaImage) ? (
                      <webview
                        ref={figmaWebviewRef}
                        src={figmaUrl}
                        partition="persist:figma"
                        allowpopups="true"
                      useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
                    />
                  ) : figmaImage ? (
                    <img
                      src={figmaImage}
                      alt="Figma PNG reference"
                      draggable={false}
                      style={{
                        transform: `translateY(-${pageScrollY * scale}px)`,
                      }}
                    />
                  ) : null}
                </div>
              )}

              {/* Multi-Device Canvas & Stage Rendering */}
              {(() => {
                const enabledFrames = activeFrames.filter((f) => f.enabled);
                const isMulti = canvasViewMode === "multi" && enabledFrames.length > 0;
                
                // Active frame for editing (default to matching activeFrameId or first enabled frame)
                const activeFrame = isMulti
                  ? (enabledFrames.find((f) => f.id === activeFrameId) || enabledFrames[0])
                  : null;

                let currentLeft = liveFrameLeft;

                return (
                  <>
                    {enabledFrames.length === 0 && isMulti ? (
                      <div
                        style={{
                          position: "absolute",
                          left: liveFrameLeft,
                          top: liveFrameTop,
                          color: "#a1a1aa",
                          fontSize: 13,
                          padding: "20px 24px",
                          background: "rgba(24, 24, 27, 0.8)",
                          borderRadius: 8,
                          border: "1px solid rgba(255, 255, 255, 0.1)",
                        }}
                      >
                        No active frames enabled. Click <strong>Desktop</strong>, <strong>Tablet</strong>, or <strong>Mobile</strong> in the toolbar to enable device frames on canvas.
                      </div>
                    ) : (
                      (isMulti ? enabledFrames : [{ id: "single-default", name: "Live Site", width, height, deviceType: "desktop", enabled: true } as any]).map((frame) => {
                        const isActive = !isMulti || frame.id === activeFrame?.id;
                        const fWidth = isMulti ? frame.width : width;
                        const fHeight = isMulti ? frame.height : height;
                        const frameGeometry = canvasViewportGeometry(fWidth, fHeight, zoom);
                        const fScaledWidth = frameGeometry.displayedWidth;
                        const fScaledHeight = frameGeometry.displayedHeight;
                        
                        const frameOffset = isMulti ? (multiFrameOffsets[frame.id] || { x: 0, y: 0 }) : { x: 0, y: 0 };
                        const thisLeft = (isMulti ? currentLeft : liveFrameLeft) + frameOffset.x * scale;
                        const thisTop = liveFrameTop + frameOffset.y * scale;

                        if (isMulti) {
                          currentLeft += fScaledWidth + 48;
                        }

                        return (
                          <div
                            key={frame.id}
                            ref={isActive ? liveFrameRef : undefined}
                            className={`edit-beta-site-stage ${isMulti ? "edit-beta-multi-stage" : ""}`}
                            style={{
                              left: thisLeft,
                              top: thisTop,
                              width: fScaledWidth,
                              height: fScaledHeight,
                              position: "absolute",
                              boxShadow: isMulti && isActive ? "0 0 0 2px #3b82f6, 0 8px 24px rgba(0,0,0,0.5)" : undefined,
                              borderRadius: isMulti ? 8 : undefined,
                              transition: "box-shadow 0.15s ease",
                            }}
                            onPointerDownCapture={() => {
                              if (isMulti && !isActive && onSelectActiveFrame) {
                                onSelectActiveFrame(frame.id);
                              }
                            }}
                          >
                            <div
                              className="edit-beta-compare-label"
                              style={{
                                width: fScaledWidth,
                                height: 30,
                                minHeight: 30,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                flexWrap: "nowrap",
                                padding: "0 8px",
                                boxSizing: "border-box",
                                background: isMulti && isActive ? "rgba(59, 130, 246, 0.18)" : undefined,
                                borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
                                cursor: "grab",
                              }}
                              onPointerDown={(event) =>
                                isMulti ? beginMultiDeviceFrameDrag(frame.id, event) : beginFrameDrag("live", event)
                              }
                            >
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, flexShrink: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {frame.deviceType === "desktop" ? (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                                    <rect x="2" y="3" width="20" height="14" rx="2" />
                                    <line x1="8" y1="21" x2="16" y2="21" />
                                  </svg>
                                ) : frame.deviceType === "tablet" ? (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                                    <rect x="4" y="2" width="16" height="20" rx="2" />
                                  </svg>
                                ) : (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                                    <rect x="6" y="2" width="12" height="20" rx="2" />
                                  </svg>
                                )}
                                <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{frame.name}</strong>
                                <span style={{ opacity: 0.65, fontSize: 11, flexShrink: 0 }}>• {frame.width}×{frame.height}</span>
                                {isMulti && isActive && (
                                  <span
                                    title="Active Editing Frame"
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      width: 18,
                                      height: 18,
                                      background: "#3b82f6",
                                      color: "#ffffff",
                                      borderRadius: 4,
                                      flexShrink: 0,
                                    }}
                                  >
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                      <path d="M12 20h9" />
                                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                    </svg>
                                  </span>
                                )}
                              </span>
                              {isMulti ? (
                                <div style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                                  {!isActive && (
                                    <button
                                      onClick={() => onSelectActiveFrame?.(frame.id)}
                                      style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        width: 20,
                                        height: 20,
                                        background: "rgba(255,255,255,0.08)",
                                        border: "1px solid rgba(255,255,255,0.15)",
                                        color: "#e4e4e7",
                                        borderRadius: 4,
                                        cursor: "pointer",
                                      }}
                                      title="Click to edit this device frame"
                                    >
                                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <polygon points="3 11 22 2 13 21 11 13 3 11" />
                                      </svg>
                                    </button>
                                  )}
                                  <button
                                    onClick={() => onRemoveFrame?.(frame.id)}
                                    style={{
                                      background: "transparent",
                                      border: "none",
                                      color: "#a1a1aa",
                                      cursor: "pointer",
                                      padding: "2px 4px",
                                      fontSize: 14,
                                      lineHeight: 1,
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      borderRadius: 3,
                                    }}
                                    title="Remove device frame"
                                  >
                                    ×
                                  </button>
                                </div>
                              ) : null}
                            </div>

                            {isActive && frameSnapGuide.active && frameSnapGuide.x != null && (
                              <div
                                className="edit-beta-position-guide guide-top"
                                style={{
                                  left: `${frameSnapGuide.x}px`,
                                  top: 0,
                                  height: `${fScaledHeight}px`,
                                }}
                              >
                                <span>Snap</span>
                              </div>
                            )}

                            {isActive && (guidesOn || guidesAlwaysVisible) && (
                              <>
                                {guides.map((guide, index) => (
                                  <div
                                    key={`prop-guide-${guide.axis}-${guide.position}-${index}`}
                                    className={`edit-beta-guide edit-beta-guide-${guide.axis}`}
                                    style={
                                      guide.axis === "x"
                                        ? { top: `${guide.position * 100}%` }
                                        : { left: `${guide.position * 100}%` }
                                    }
                                    onMouseEnter={(e) => {
                                      const px =
                                        guide.axis === "x"
                                          ? Math.round(guide.position * fHeight)
                                          : Math.round(guide.position * fWidth);
                                      setHoveredGuideInfo({
                                        axis: guide.axis,
                                        px,
                                        screenX: e.clientX,
                                        screenY: e.clientY,
                                      });
                                    }}
                                    onMouseMove={(e) => {
                                      const px =
                                        guide.axis === "x"
                                          ? Math.round(guide.position * fHeight)
                                          : Math.round(guide.position * fWidth);
                                      setHoveredGuideInfo({
                                        axis: guide.axis,
                                        px,
                                        screenX: e.clientX,
                                        screenY: e.clientY,
                                      });
                                    }}
                                    onMouseLeave={() => setHoveredGuideInfo(null)}
                                  />
                                ))}
                              </>
                            )}

                            <div
                              ref={isActive ? activeViewportRef : undefined}
                              className="edit-beta-frame"
                              style={{
                                width: frameGeometry.surfaceWidth,
                                height: frameGeometry.surfaceHeight,
                                transform: `scale(${scale})`,
                                transformOrigin: "top left",
                                pointerEvents: "auto",
                              }}
                            >
                              <webview
                                ref={(el) => {
                                  if (el) {
                                    webviewsMapRef.current[frame.id] = el;
                                    if (isActive) {
                                      webviewRef.current = el;
                                    }
                                  } else {
                                    delete webviewsMapRef.current[frame.id];
                                  }
                                }}
                                src={sourceUrl}
                                allowpopups="true"
                              />
                              {isActive && capturePreviewDataUrl && (
                                <img
                                  className="edit-beta-capture-preview"
                                  src={capturePreviewDataUrl}
                                  alt=""
                                  aria-hidden="true"
                                />
                              )}
                            </div>

                            {isActive && mode === "edit" && selected && (
                              <SelectionOverlay
                                selected={selected}
                                scale={scale}
                                boundaries={boundaries}
                                fontFamilies={pageFonts.map((font) => font.family)}
                                onResize={handleElementDragStyle}
                                onBoxChange={(property, value) =>
                                  handleElementDragStyle({ [property]: `${value}px` }, true)
                                }
                                onTextStyle={(values, isFinal = true) =>
                                  handleElementDragStyle(values, isFinal)
                                }
                                onReorder={(targetPath, placement) => {
                                  void call("reorder", targetPath, placement);
                                  void refreshLayers();
                                }}
                                onAnnotate={() => onAnnotateElement?.(selected)}
                                onAction={(action) => {
                                  const calls = {
                                    parent: ["selectParent"],
                                    up: ["move", -1],
                                    down: ["move", 1],
                                    duplicate: ["duplicate"],
                                    delete: ["remove"],
                                  } as const;
                                  const [method, argument] = calls[action];
                                  void call(
                                    method,
                                    ...((argument === undefined
                                      ? []
                                      : [argument]) as any[]),
                                  );
                                }}
                              />
                            )}

                            {isActive && comparisonVisible && !sideBySide && (
                              <div
                                className="edit-beta-overlay-viewport"
                                style={{
                                  width: fScaledWidth,
                                  height: fScaledHeight,
                                  opacity: overlayOpacity / 100,
                                  mixBlendMode:
                                    overlayMode === "diff" ? "difference" : "normal",
                                }}
                              >
                                <img
                                  className="edit-beta-overlay"
                                  src={overlayImage!}
                                  alt={overlayLabel || "Design comparison"}
                                  style={{
                                    width: fScaledWidth,
                                    transform: `translateY(-${pageScrollY * scale}px)`,
                                  }}
                                />
                              </div>
                            )}

                            {isActive && viewportMode === "free" && !isMulti && (
                              <>
                                <button
                                  className="edit-beta-resize-handle edit-beta-resize-right"
                                  style={{ left: fScaledWidth - 3 }}
                                  onPointerDown={(event) => beginResize(event, "x")}
                                  aria-label="Resize viewport width"
                                />
                                <button
                                  className="edit-beta-resize-handle edit-beta-resize-bottom"
                                  style={{ left: fScaledWidth / 2 }}
                                  onPointerDown={(event) => beginResize(event, "y")}
                                  aria-label="Resize viewport height"
                                />
                                <button
                                  className="edit-beta-resize-handle edit-beta-resize-corner"
                                  style={{ left: fScaledWidth - 5 }}
                                  onPointerDown={(event) => beginResize(event, "both")}
                                  aria-label="Resize viewport"
                                />
                              </>
                            )}
                          </div>
                        );
                      })
                    )}
                  </>
                );
              })()}

              {snapshotSideVisible && (
                <div
                  className="edit-beta-compare-frame edit-beta-compare-snapshot"
                  style={{
                    left: snapshotFrameLeft,
                    top: snapshotFrameTop,
                    width: scaledWidth,
                    height: scaledHeight,
                  }}
                >
                  <div
                    className="edit-beta-compare-label"
                    onPointerDown={(event) => beginFrameDrag("snapshot", event)}
                  >
                    <span>
                      ▣ Site Snapshot
                      {snapshotLabel !== "Site Snapshot"
                        ? ` (${snapshotLabel})`
                        : ""}
                    </span>
                    <button
                      onClick={onCloseSnapshotPanel}
                      title="Close snapshot panel"
                    >
                      ×
                    </button>
                  </div>
                  <div className="edit-beta-snapshot-viewport">
                    <img
                      src={snapshotImage!}
                      alt="Site snapshot"
                      draggable={false}
                      style={{
                        transform: `translateY(-${pageScrollY * scale}px)`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </main>

          <aside
            className={`edit-beta-right ${rightPanelOpen ? "is-open" : "is-collapsed"}`}
            aria-hidden={!rightPanelOpen}
          >
            <div
              className="edit-beta-panel-resizer edit-beta-panel-resizer-right"
              onPointerDown={(event) => beginPanelResize(event, "right")}
              onPointerMove={movePanelResize}
              onPointerUp={endPanelResize}
              onPointerCancel={endPanelResize}
            />
            <div className="edit-beta-right-scroll">
              <div className="edit-beta-palette">
                <button
                  className="edit-beta-section-toggle"
                  onClick={() => setColorsOpen((value) => !value)}
                >
                  <span>{colorsOpen ? "⌄" : "›"} Colors</span>
                  <span>{pageColors.length}</span>
                </button>
                {colorsOpen && (
                  <div className="edit-beta-color-list">
                    {pageColors.map(({ hex, count }) => (
                      <button
                        key={hex}
                        className={selectedColors.has(hex) ? "active" : ""}
                        title={`Highlight ${count} uses`}
                        onClick={() => {
                          setSelectedFonts(new Set());
                          setSelectedColors((current) => {
                            const next = new Set(current);
                            next.has(hex) ? next.delete(hex) : next.add(hex);
                            return next;
                          });
                        }}
                      >
                        <i style={{ background: hex }} />
                        <span>{hex}</span>
                        <small>{count}</small>
                      </button>
                    ))}
                    <button
                      className="edit-beta-rescan"
                      onClick={() => void scanColors()}
                    >
                      Rescan colors
                    </button>
                  </div>
                )}
                <button
                  className="edit-beta-section-toggle"
                  onClick={() => setFontsOpen((value) => !value)}
                >
                  <span>{fontsOpen ? "⌄" : "›"} Fonts</span>
                  <span>{pageFonts.length}</span>
                </button>
                {fontsOpen && (
                  <div className="edit-beta-font-list">
                    {pageFonts.map(({ family, count, preview, loaded }) => (
                      <button
                        key={family}
                        className={selectedFonts.has(family) ? "active" : ""}
                        title={`${family} · ${count} uses${loaded === false ? " · browser fallback detected" : ""}`}
                        onClick={() => {
                          setSelectedColors(new Set());
                          setSelectedFonts((current) => {
                            const next = new Set(current);
                            next.has(family)
                              ? next.delete(family)
                              : next.add(family);
                            return next;
                          });
                        }}
                      >
                        {preview ? (
                          <img src={preview} alt={family} />
                        ) : (
                          <span
                            style={{ fontFamily: `"${family}", sans-serif` }}
                          >
                            {family}
                          </span>
                        )}
                        <small>{count}</small>
                      </button>
                    ))}
                    <button
                      className="edit-beta-rescan"
                      onClick={() => void scanFonts()}
                    >
                      Rescan fonts
                    </button>
                  </div>
                )}
              </div>
              {!selected ? (
                <div className="edit-beta-empty">
                  Select an element on the page or in Layers.
                </div>
              ) : (
                <>
                  <div className="edit-beta-section-title">Text</div>
                  <textarea
                    value={textDraft}
                    onChange={(e) => setTextDraft(e.target.value)}
                  />
                  <button
                    className="edit-beta-apply"
                    onClick={() => void call("setText", textDraft)}
                  >
                    Apply text
                  </button>
                  <div className="edit-beta-section-title">Selectors</div>
                  <div className="edit-beta-selector-row">
                    <span>Classes</span>
                    <input
                      value={classDraft}
                      onChange={(e) => setClassDraft(e.target.value)}
                      onBlur={() =>
                        void call("setAttribute", "class", classDraft)
                      }
                      placeholder="class-one class-two"
                    />
                  </div>
                  <div className="edit-beta-section-title">Styles</div>
                  <NativeStylePanel
                    selectedElement={null}
                    computedStyles={styleDrafts}
                    onStyleChange={(property, value, isFinal = true) => {
                      setStyleDrafts((current) => ({
                        ...current,
                        [property]: value,
                      }));
                      void call(
                        isFinal ? "setStyle" : "previewStyle",
                        property,
                        value,
                      );
                    }}
                  />
                  <div className="edit-beta-section-title">Attribute</div>
                  <div className="edit-beta-attribute">
                    <input
                      placeholder="name"
                      value={attrName}
                      onChange={(e) => setAttrName(e.target.value)}
                    />
                    <input
                      placeholder="value"
                      value={attrValue}
                      onChange={(e) => setAttrValue(e.target.value)}
                    />
                    <button
                      onClick={() =>
                        void call("setAttribute", attrName, attrValue)
                      }
                    >
                      Set
                    </button>
                  </div>
                </>
              )}
            </div>
          </aside>
        </div>
      </div>
    );
  },
);

export default EditBetaWorkspace;
