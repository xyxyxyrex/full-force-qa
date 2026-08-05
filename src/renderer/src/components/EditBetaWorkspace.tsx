import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import "./EditBetaWorkspace.css";
import "./EditBetaWorkspace.ported.css";
import NativeStylePanel from "./NativeStylePanel";
import SmoothColorPicker from "./SmoothColorPicker";
import figmaIcon from "../assets/figma.png";

interface Props {
  sourceUrl: string;
  width: number;
  height: number;
  zoom: number;
  interactionMode: "edit" | "interact";
  revealAnimations: boolean;
  fontInspectorOn: boolean;
  boundaries: {
    enabled: boolean;
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
}

export interface EditBetaWorkspaceHandle {
  reload: () => void;
  undo: () => void;
  redo: () => void;
  refreshLayers: () => void;
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
  mode: "edit" | "interact";
  history: string[];
  historyIndex: number;
  patches: any[];
  scrollY: number;
}

interface BridgeOptions {
  revealAnimations: boolean;
  fontInspectorOn: boolean;
  boundaries: Props["boundaries"];
  zoomScale: number;
}

// This function is serialized and executed inside the real guest page. It uses
// a fixed Shadow DOM overlay, so inspection never changes site layout or CSS.
function installEditBetaBridge() {
  const guestWindow = window as any;
  if (guestWindow.__fullForceEditBeta) {
    if (guestWindow.__fullForceEditBeta.version === 8) {
      guestWindow.__fullForceEditBeta.enable();
      return true;
    }
    try {
      guestWindow.__fullForceEditBeta.cleanup?.();
    } catch {}
  }

  let mode = "edit";
  let selected: HTMLElement | null = null;
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
    fontInspectorOn: false,
    boundaries: {
      enabled: false,
      showMargins: true,
      showPaddings: true,
      showDimensions: true,
      showGaps: true,
    },
    zoomScale: 1,
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
  shadow.append(highlights, measurements, marginBox, paddingBox, box, label);
  document.documentElement.appendChild(host);
  let highlightedElements: HTMLElement[] = [];
  let highlightedColor = "#a78bfa";
  let highlightFrame = 0;
  let measurementFrame = 0;

  const revealStyle = document.createElement("style");
  revealStyle.setAttribute("data-fullforce-beta-ui", "true");
  revealStyle.textContent = `[data-aos],[class*="reveal"],[class*="animate"],[class*="fade"]{opacity:1!important;visibility:visible!important;transform:none!important;animation:none!important;transition:none!important}`;
  const cursorStyle = document.createElement("style");
  cursorStyle.setAttribute("data-fullforce-beta-ui", "true");
  cursorStyle.textContent = `html *{cursor:pointer!important}input,textarea,[contenteditable="true"]{cursor:text!important}select{cursor:default!important}`;

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
  const positionOverlay = () => {
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
    label.textContent = `${selected.tagName.toLowerCase()}${selected.id ? `#${selected.id}` : ""}  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    Object.assign(label.style, {
      display: "block",
      left: `${Math.max(0, rect.left)}px`,
      top: `${Math.max(0, rect.top - 23)}px`,
    });
    if (options.boundaries.enabled) {
      const dimensionDetails = options.boundaries.showDimensions
        ? `  ${Math.round(rect.width)}×${Math.round(rect.height)}`
        : "";
      const gapValue = cs.gap && cs.gap !== "normal" ? cs.gap : "";
      const gapDetails =
        options.boundaries.showGaps && gapValue ? `  gap ${gapValue}` : "";
      label.textContent = `${selected.tagName.toLowerCase()}${selected.id ? `#${selected.id}` : ""}${dimensionDetails}${gapDetails}`;
    }
    if (options.fontInspectorOn)
      label.textContent += `  ${cs.fontFamily.split(",")[0]} ${cs.fontSize}/${cs.fontWeight}`;
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
    // The host editor renders selection handles and box-model chrome above the
    // webview. Keep only the optional font label inside the guest page.
    box.style.display = "none";
    marginBox.style.display = "none";
    paddingBox.style.display = "none";
    if (!options.fontInspectorOn) label.style.display = "none";
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
          width > 0 && height === 0 ? "1px dashed rgba(255,80,80,.95)" : "none",
        borderLeft:
          height > 0 && width === 0 ? "1px dashed rgba(255,80,80,.95)" : "none",
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
        background: "rgba(255,80,80,.95)",
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
      const redo = () => {
        el.innerHTML = afterHtml;
      };
      const undo = () => {
        el.innerHTML = beforeHtml;
      };
      commit(
        { label: "Edit text inline", undo, redo },
        { type: "html", path, value: afterHtml },
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
  const select = (el: HTMLElement | null) => {
    if (inlineEditing && inlineEditing !== el) finishInlineEdit(true);
    selected = el;
    hovered = null;
    positionOverlay();
    scheduleMeasurements();
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
  let suppressClickAfterPan = false;
  const onMove = (event: MouseEvent) => {
    if (mode !== "edit") return;
    const target = event.target as HTMLElement | null;
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
  };
  const onClick = (event: MouseEvent) => {
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
      (event.target === inlineEditing ||
        inlineEditing.contains(event.target as Node))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    select(target);
    beginInlineEdit(target, event.clientX, event.clientY);
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseleave", onMouseLeave, true);
  document.addEventListener("click", onClick, true);
  let spacePressed = false;
  let panActive = false;
  let panSequence = 0;
  const editableTarget = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    return !!el?.closest?.('input,textarea,select,[contenteditable="true"]');
  };
  const emitPan = (active: boolean, event?: MouseEvent) =>
    console.info(
      `__FULLFORCE_PAN__${JSON.stringify({ screenX: event?.screenX || 0, screenY: event?.screenY || 0, active, sequence: ++panSequence })}`,
    );
  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !editableTarget(event.target)) {
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        guestWindow.__fullForceEditBeta?.undo();
        return;
      }
      if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        guestWindow.__fullForceEditBeta?.redo();
        return;
      }
    }
    if (event.code === "Space" && !editableTarget(event.target)) {
      spacePressed = true;
      event.preventDefault();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === "Space") {
      spacePressed = false;
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
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("mousedown", onPanDown, true);
  document.addEventListener("mousemove", onPanMove, true);
  document.addEventListener("mouseup", onPanUp, true);
  const refreshViewportOverlays = () => {
    positionOverlay();
    scheduleMeasurements();
  };
  window.addEventListener("scroll", refreshViewportOverlays, true);
  window.addEventListener("resize", refreshViewportOverlays, true);

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
    version: 8,
    enable() {
      host.style.display = "";
      positionOverlay();
      scheduleMeasurements();
    },
    disable() {
      host.style.display = "none";
      measurements.replaceChildren();
    },
    setMode(next: string) {
      mode = next === "interact" ? "interact" : "edit";
      if (mode === "edit" && !cursorStyle.isConnected)
        document.head.appendChild(cursorStyle);
      if (mode !== "edit" && cursorStyle.isConnected) cursorStyle.remove();
      positionOverlay();
      scheduleMeasurements();
      return mode;
    },
    setOptions(next: BridgeOptions) {
      options = {
        ...options,
        ...next,
        boundaries: { ...options.boundaries, ...(next?.boundaries || {}) },
      };
      if (options.revealAnimations && !revealStyle.isConnected)
        document.head.appendChild(revealStyle);
      if (!options.revealAnimations && revealStyle.isConnected)
        revealStyle.remove();
      positionOverlay();
      scheduleMeasurements();
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
      const redo = () =>
        after
          ? el.style.setProperty(property, after, "important")
          : el.style.removeProperty(property);
      const undo = () =>
        before
          ? el.style.setProperty(property, before, beforePriority)
          : el.style.removeProperty(property);
      redo();
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
          priority: after ? "important" : "",
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
        { type: "text", path: getPath(el), value },
      );
      positionOverlay();
      return true;
    },
    setHtml(value: string) {
      if (!selected) return false;
      if (inlineEditing) finishInlineEdit(true);
      const el = selected;
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
        { type: "html", path: getPath(el), value },
      );
      positionOverlay();
      return true;
    },
    setAttribute(name: string, value: string | null) {
      if (!selected || !name) return false;
      const el = selected;
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
          label: `${el.tagName.toLowerCase()} · ${name} attribute`,
          undo,
          redo,
        },
        { type: "attribute", path, name, value },
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
      clearHighlights();
      positionOverlay();
      return true;
    },
    cleanup() {
      if (inlineEditing) finishInlineEdit(true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseleave", onMouseLeave, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("mousedown", onPanDown, true);
      document.removeEventListener("mousemove", onPanMove, true);
      document.removeEventListener("mouseup", onPanUp, true);
      window.removeEventListener("scroll", refreshViewportOverlays, true);
      window.removeEventListener("resize", refreshViewportOverlays, true);
      window.removeEventListener("scroll", scheduleHighlights, true);
      window.removeEventListener("resize", scheduleHighlights, true);
      if (measurementFrame) cancelAnimationFrame(measurementFrame);
      measurementFrame = 0;
      measurements.replaceChildren();
      clearHighlights();
      revealStyle.remove();
      cursorStyle.remove();
      host.remove();
      delete guestWindow.__fullForceEditBeta;
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
  const marginStyle = {
    left: (dragRect.left - box.marginLeft) * scale,
    top: (dragRect.top - box.marginTop) * scale,
    width: (dragRect.width + box.marginLeft + box.marginRight) * scale,
    height: (dragRect.height + box.marginTop + box.marginBottom) * scale,
  };
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
        <div className="edit-beta-box-margin" style={marginStyle} />
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
      fontInspectorOn,
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
    },
    ref,
  ) {
    const webviewRef = useRef<any>(null);
    const figmaWebviewRef = useRef<any>(null);
    const canvasRef = useRef<HTMLElement>(null);
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
      divider: "layers" | "styles";
      pointerId: number;
      startY: number;
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
    const modeRef = useRef<"edit" | "interact">(interactionMode);
    const optionsRef = useRef<BridgeOptions>({
      revealAnimations,
      fontInspectorOn,
      boundaries,
      zoomScale: Math.max(0.25, zoom / 100),
    });
    const selectedStateKeyRef = useRef("");
    const historyStateKeyRef = useRef("");
    const [ready, setReady] = useState(false);
    const [mode, setMode] = useState<"edit" | "interact">(interactionMode);
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
      layers: true,
      styles: true,
      history: true,
    });
    const [layersSectionHeight, setLayersSectionHeight] = useState(
      () => Number(localStorage.getItem("qa_edit_layers_height")) || 340,
    );
    const [stylesSectionHeight, setStylesSectionHeight] = useState(
      () => Number(localStorage.getItem("qa_edit_styles_height")) || 260,
    );
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
    const scale = Math.max(0.25, zoom / 100);
    const comparisonVisible = !!overlayImage && !!overlayVisible;
    const sideBySide = !!overlayVisible && overlayMode === "side-by-side";
    const figmaSideVisible =
      sideBySide && figmaPanelVisible && !!(figmaUrl || figmaImage);
    const snapshotSideVisible = sideBySide && !!snapshotImage;
    const scaledWidth = width * scale;
    const scaledHeight = height * scale;
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
        divider: "layers" | "styles",
      ) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setLeftSections((current) =>
          divider === "layers"
            ? { ...current, layers: true, styles: true }
            : { ...current, styles: true, history: true },
        );
        sectionDragRef.current = {
          divider,
          pointerId: event.pointerId,
          startY: event.clientY,
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
        let nextLayers = drag.layersHeight;
        let nextStyles = drag.stylesHeight;
        if (drag.divider === "layers") {
          const total = drag.layersHeight + drag.stylesHeight;
          nextLayers = Math.max(
            120,
            Math.min(total - 120, drag.layersHeight + delta),
          );
          nextStyles = total - nextLayers;
        } else {
          nextStyles = Math.max(120, Math.min(560, drag.stylesHeight + delta));
        }
        layersSectionHeightRef.current = Math.round(nextLayers);
        stylesSectionHeightRef.current = Math.round(nextStyles);
        if (sectionResizeFrameRef.current != null)
          cancelAnimationFrame(sectionResizeFrameRef.current);
        sectionResizeFrameRef.current = requestAnimationFrame(() => {
          sectionResizeFrameRef.current = null;
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
        setLayersSectionHeight(layersSectionHeightRef.current);
        setStylesSectionHeight(stylesSectionHeightRef.current);
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
      const view = webviewRef.current;
      if (!view || typeof view.executeJavaScript !== "function") return null;
      try {
        return await view.executeJavaScript(expression, true);
      } catch {
        return null;
      }
    }, []);

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
      const view = webviewRef.current;
      if (!view) return;
      const onLoad = () => {
        setReady(false);
        try {
          const currentUrl =
            typeof view.getURL === "function" ? view.getURL() : "";
          if (currentUrl) setUrl(currentUrl);
        } catch {}
        void install();
      };
      const onNavigate = (event: any) => {
        if (event.url) setUrl(event.url);
      };
      const onFinishedLoad = () => {
        window.setTimeout(() => void captureProjectThumbnail(), 180);
      };
      const onConsoleMessage = (event: any) => {
        const message = String(event.message || "");
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
      return () => {
        view.removeEventListener("dom-ready", onLoad);
        view.removeEventListener("did-finish-load", onFinishedLoad);
        view.removeEventListener("did-navigate", onNavigate);
        view.removeEventListener("did-navigate-in-page", onNavigate);
        view.removeEventListener("console-message", onConsoleMessage);
      };
    }, [captureProjectThumbnail, constrainPan, install, sourceUrl]);

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
      if (ready)
        void execute(
          `window.__fullForceEditBeta?.setMode(${JSON.stringify(interactionMode)})`,
        );
    }, [execute, interactionMode, ready]);

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
        fontInspectorOn,
        boundaries,
        zoomScale: Math.max(0.25, zoom / 100),
      };
      if (ready)
        void execute(
          `window.__fullForceEditBeta?.setOptions(${JSON.stringify(optionsRef.current)})`,
        );
    }, [boundaries, execute, fontInspectorOn, ready, revealAnimations, zoom]);

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
      const result = await execute(
        `window.__fullForceEditBeta?.[${JSON.stringify(method)}](...${JSON.stringify(args)})`,
      );
      if (["duplicate", "remove", "move", "undo", "redo"].includes(method))
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
    }, [ready]);
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
        undo: () => {
          void call("undo");
        },
        redo: () => {
          void call("redo");
        },
        refreshLayers: () => {
          void refreshLayers();
        },
      }),
      [hardReload, refreshLayers],
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
    const beginResize = (event: React.MouseEvent, axis: "x" | "y" | "both") => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = width;
      const startHeight = height;
      const onMove = (moveEvent: MouseEvent) => {
        const nextWidth =
          axis === "y"
            ? startWidth
            : Math.max(
                100,
                Math.round(startWidth + (moveEvent.clientX - startX) / scale),
              );
        const nextHeight =
          axis === "x"
            ? startHeight
            : Math.max(
                100,
                Math.round(startHeight + (moveEvent.clientY - startY) / scale),
              );
        onViewportResize(nextWidth, nextHeight);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
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
                      allowpopups={true}
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

              <div
                ref={liveFrameRef}
                className="edit-beta-site-stage"
                style={{
                  left: liveFrameLeft,
                  top: liveFrameTop,
                  width: scaledWidth,
                  height: scaledHeight,
                }}
              >
                <div
                  className="edit-beta-compare-label"
                  style={{
                    width: scaledWidth,
                  }}
                  onPointerDown={(event) => beginFrameDrag("live", event)}
                >
                  <span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <path d="M7 3v18" />
                      <path d="M3 7h18" />
                    </svg>
                    Live Site
                  </span>
                </div>
                {frameSnapGuide.active && frameSnapGuide.x != null && (
                  <div
                    className="edit-beta-position-guide guide-top"
                    style={{
                      left: `${frameSnapGuide.x}px`,
                      top: 0,
                      height: `${scaledHeight}px`,
                    }}
                  >
                    <span>Snap</span>
                  </div>
                )}

                {(guidesOn || guidesAlwaysVisible) && (
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
                              ? Math.round(guide.position * height)
                              : Math.round(guide.position * width);
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
                              ? Math.round(guide.position * height)
                              : Math.round(guide.position * width);
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
                    {localGuides.map((guide) => (
                      <div
                        key={guide.id}
                        className={`edit-beta-guide edit-beta-guide-${guide.axis}`}
                        style={
                          guide.axis === "x"
                            ? { top: `${guide.position * 100}%` }
                            : { left: `${guide.position * 100}%` }
                        }
                        onPointerDown={(event) =>
                          beginExistingGuideDrag(guide.id, guide.axis, event)
                        }
                        onMouseEnter={(e) => {
                          const px =
                            guide.axis === "x"
                              ? Math.round(guide.position * height)
                              : Math.round(guide.position * width);
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
                              ? Math.round(guide.position * height)
                              : Math.round(guide.position * width);
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
                  className="edit-beta-frame"
                  style={{
                    width,
                    height,
                    transform: `scale(${scale})`,
                    pointerEvents: "auto",
                  }}
                >
                  <webview
                    ref={webviewRef}
                    src={sourceUrl}
                    allowpopups={true}
                  />
                </div>
                {mode === "edit" && selected && (
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
                {comparisonVisible && !sideBySide && (
                  <div
                    className="edit-beta-overlay-viewport"
                    style={{
                      width: scaledWidth,
                      height: scaledHeight,
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
                        width: scaledWidth,
                        transform: `translateY(-${pageScrollY * scale}px)`,
                      }}
                    />
                  </div>
                )}
                {viewportMode === "free" && (
                  <>
                    <button
                      className="edit-beta-resize-handle edit-beta-resize-right"
                      style={{ left: scaledWidth - 3 }}
                      onMouseDown={(event) => beginResize(event, "x")}
                      aria-label="Resize viewport width"
                    />
                    <button
                      className="edit-beta-resize-handle edit-beta-resize-bottom"
                      style={{ left: scaledWidth / 2 }}
                      onMouseDown={(event) => beginResize(event, "y")}
                      aria-label="Resize viewport height"
                    />
                    <button
                      className="edit-beta-resize-handle edit-beta-resize-corner"
                      style={{ left: scaledWidth - 5 }}
                      onMouseDown={(event) => beginResize(event, "both")}
                      aria-label="Resize viewport"
                    />
                  </>
                )}
              </div>

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
