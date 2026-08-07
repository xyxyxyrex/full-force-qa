import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import "./BeforeAfterSnippingModal.css";

export interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
  vw?: number;
  vh?: number;
}

export interface RecordedChangeItem {
  type?: string;
  property?: string;
  value?: string;
  beforeValue?: string;
  name?: string;
  path?: string;
  tag?: string;
  rectBefore?: ElementRect;
  rectAfter?: ElementRect;
  rect?: ElementRect;
}

export interface BeforeAfterSnippingModalProps {
  isOpen: boolean;
  onClose: () => void;
  beforeImage: string | null;
  afterImage: string | null;
  recordedChanges?: RecordedChangeItem[];
  onSaveSnapshot?: (dataUrl: string, title: string) => void;
}

type ViewMode = "side" | "wipe" | "diff";
type AnnotationTool = "none" | "arrow" | "text" | "rect" | "circle" | "pen";

interface Annotation {
  id: string;
  tool: AnnotationTool;
  color: string;
  width: number;
  // Shape coordinates
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  points?: Array<{ x: number; y: number }>;
  text?: string;
}

const COLORS = [
  "#ff0055", // Neon Pink
  "#f59e0b", // Warning Yellow
  "#22c55e", // Success Green
  "#3b82f6", // Accent Blue
  "#ffffff", // White
];

export const BeforeAfterSnippingModal: React.FC<BeforeAfterSnippingModalProps> = ({
  isOpen,
  onClose,
  beforeImage,
  afterImage,
  recordedChanges = [],
  onSaveSnapshot,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>("wipe");
  const [activeTool, setActiveTool] = useState<AnnotationTool>("arrow");
  const [color, setColor] = useState<string>("#ff0055");
  const [strokeWidth, setStrokeWidth] = useState<number>(3);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[]>([]);
  const [wipePos, setWipePos] = useState<number>(50); // percentage
  const [isWiping, setIsWiping] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Filter & Deduplicate changes by path + property, excluding full-page container rects
  const uniqueChanges = useMemo(() => {
    if (!recordedChanges || recordedChanges.length === 0) return [];
    const map = new Map<string, RecordedChangeItem>();
    recordedChanges.forEach((change) => {
      const prop = (change.property || change.name || change.type || "style").toLowerCase();
      const r = change.rectAfter || change.rect || change.rectBefore;
      if (r && r.vw && r.vh) {
        if (r.width > r.vw * 0.85 && r.height > r.vh * 0.85) {
          return;
        }
      }
      const key = `${change.path || "el"}::${prop}`;
      map.set(key, change);
    });
    return Array.from(map.values());
  }, [recordedChanges]);

  // Refs for Image Dimension & Wipe Drag Tracking
  const baseImgRef = useRef<HTMLImageElement | null>(null);
  const sideBeforeImgRef = useRef<HTMLImageElement | null>(null);
  const sideAfterImgRef = useRef<HTMLImageElement | null>(null);
  const wipeWrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  const [imgDimensions, setImgDimensions] = useState<{ width: number; height: number } | null>(null);

  const updateImgDimensions = useCallback(() => {
    const img = baseImgRef.current || sideBeforeImgRef.current || sideAfterImgRef.current;
    if (img && img.clientWidth > 0 && img.clientHeight > 0) {
      setImgDimensions({
        width: img.clientWidth,
        height: img.clientHeight,
      });
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      updateImgDimensions();
    }
  }, [isOpen, updateImgDimensions, viewMode]);

  useEffect(() => {
    window.addEventListener("resize", updateImgDimensions);
    return () => window.removeEventListener("resize", updateImgDimensions);
  }, [updateImgDimensions]);

  // ── Global Window Mouse Events for Smooth 100% Wipe Slider Dragging ──
  useEffect(() => {
    if (!isWiping) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      const wrapper = wipeWrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
      setWipePos(pct);
    };

    const handleWindowMouseUp = () => {
      setIsWiping(false);
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [isWiping]);

  // Drawing state
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [currentAnnotation, setCurrentAnnotation] = useState<Annotation | null>(null);

  // Show Toast helper
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  // Keyboard shortcut listener for Undo/Redo & Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        handleRedo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, annotations, redoStack]);

  // Redraw annotations on canvas
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const itemsToDraw = [...annotations, ...(currentAnnotation ? [currentAnnotation] : [])];

    itemsToDraw.forEach((item) => {
      ctx.strokeStyle = item.color;
      ctx.fillStyle = item.color;
      ctx.lineWidth = item.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      if (
        item.tool === "arrow" &&
        item.startX !== undefined &&
        item.startY !== undefined &&
        item.endX !== undefined &&
        item.endY !== undefined
      ) {
        const dx = item.endX - item.startX;
        const dy = item.endY - item.startY;
        const angle = Math.atan2(dy, dx);
        const headLength = Math.max(12, item.width * 4);

        // Line
        ctx.beginPath();
        ctx.moveTo(item.startX, item.startY);
        ctx.lineTo(item.endX, item.endY);
        ctx.stroke();

        // Arrowhead
        ctx.beginPath();
        ctx.moveTo(item.endX, item.endY);
        ctx.lineTo(
          item.endX - headLength * Math.cos(angle - Math.PI / 6),
          item.endY - headLength * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          item.endX - headLength * Math.cos(angle + Math.PI / 6),
          item.endY - headLength * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();
      } else if (
        item.tool === "rect" &&
        item.startX !== undefined &&
        item.startY !== undefined &&
        item.endX !== undefined &&
        item.endY !== undefined
      ) {
        const w = item.endX - item.startX;
        const h = item.endY - item.startY;
        ctx.beginPath();
        ctx.rect(item.startX, item.startY, w, h);
        ctx.stroke();
      } else if (
        item.tool === "circle" &&
        item.startX !== undefined &&
        item.startY !== undefined &&
        item.endX !== undefined &&
        item.endY !== undefined
      ) {
        const radiusX = Math.abs(item.endX - item.startX) / 2;
        const radiusY = Math.abs(item.endY - item.startY) / 2;
        const centerX = item.startX + (item.endX - item.startX) / 2;
        const centerY = item.startY + (item.endY - item.startY) / 2;

        ctx.beginPath();
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, 2 * Math.PI);
        ctx.stroke();
      } else if (item.tool === "pen" && item.points && item.points.length > 0) {
        ctx.beginPath();
        ctx.moveTo(item.points[0].x, item.points[0].y);
        for (let i = 1; i < item.points.length; i++) {
          ctx.lineTo(item.points[i].x, item.points[i].y);
        }
        ctx.stroke();
      } else if (
        item.tool === "text" &&
        item.startX !== undefined &&
        item.startY !== undefined &&
        item.text
      ) {
        const fontPx = Math.max(14, item.width * 4);
        ctx.font = `600 ${fontPx}px system-ui, -apple-system, sans-serif`;
        const metrics = ctx.measureText(item.text);
        const padding = 8;

        // Background pill
        ctx.fillStyle = "rgba(18, 18, 21, 0.88)";
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(
          item.startX - padding,
          item.startY - fontPx - padding / 2,
          metrics.width + padding * 2,
          fontPx + padding * 1.5,
          6
        );
        ctx.fill();
        ctx.stroke();

        // Text
        ctx.fillStyle = item.color;
        ctx.fillText(item.text, item.startX, item.startY);
      }
    });
  }, [annotations, currentAnnotation]);

  // Adjust canvas bounds on resize
  useEffect(() => {
    const updateBounds = () => {
      const workspace = workspaceRef.current;
      const canvas = canvasRef.current;
      if (!workspace || !canvas) return;
      const rect = workspace.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
        redrawCanvas();
      }
    };
    updateBounds();
    window.addEventListener("resize", updateBounds);
    return () => window.removeEventListener("resize", updateBounds);
  }, [redrawCanvas]);

  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  // Handle Mouse Drawing on Canvas
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool === "none") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (activeTool === "text") {
      const text = prompt("Enter callout note:", "Padding adjusted");
      if (text) {
        const newAnn: Annotation = {
          id: String(Date.now()),
          tool: "text",
          color,
          width: strokeWidth,
          startX: x,
          startY: y,
          text,
        };
        setAnnotations((prev) => [...prev, newAnn]);
        setRedoStack([]);
      }
      return;
    }

    setIsDrawing(true);
    setCurrentAnnotation({
      id: String(Date.now()),
      tool: activeTool,
      color,
      width: strokeWidth,
      startX: x,
      startY: y,
      endX: x,
      endY: y,
      points: activeTool === "pen" ? [{ x, y }] : undefined,
    });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !currentAnnotation) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (currentAnnotation.tool === "pen") {
      setCurrentAnnotation((prev) =>
        prev
          ? {
              ...prev,
              points: [...(prev.points || []), { x, y }],
            }
          : null
      );
    } else {
      setCurrentAnnotation((prev) =>
        prev
          ? {
              ...prev,
              endX: x,
              endY: y,
            }
          : null
      );
    }
  };

  const handleMouseUp = () => {
    if (isDrawing && currentAnnotation) {
      setAnnotations((prev) => [...prev, currentAnnotation]);
      setCurrentAnnotation(null);
      setIsDrawing(false);
      setRedoStack([]);
    }
  };

  // Undo / Redo / Clear
  const handleUndo = () => {
    setAnnotations((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const popped = next.pop();
      if (popped) setRedoStack((r) => [...r, popped]);
      return next;
    });
  };

  const handleRedo = () => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const popped = next.pop();
      if (popped) setAnnotations((a) => [...a, popped]);
      return next;
    });
  };

  const handleClear = () => {
    if (annotations.length === 0) return;
    setRedoStack([...annotations]);
    setAnnotations([]);
  };

  // Helper to calculate exact Spacing Increase Region for Padding & Margin
  const getAreaIncreaseCoords = (
    prop: string,
    val: string,
    beforeVal: string,
    targetRect: ElementRect,
    scaleX: number,
    scaleY: number
  ) => {
    const elX = Math.round(targetRect.left * scaleX);
    const elY = Math.round(targetRect.top * scaleY);
    const elW = Math.round(targetRect.width * scaleX);
    const elH = Math.round(targetRect.height * scaleY);

    const isSpacingProp = prop.includes("padding") || prop.includes("margin");
    if (!isSpacingProp) {
      return { areaX: elX, areaY: elY, areaW: elW, areaH: elH, elX, elY, elW, elH, isSpacing: false };
    }

    const valNum = parseFloat(val) || 0;
    const beforeNum = parseFloat(beforeVal) || 0;
    const delta = valNum - beforeNum;
    const absDelta = Math.abs(delta) || valNum || 20;

    const deltaPxY = Math.round(absDelta * scaleY);
    const deltaPxX = Math.round(absDelta * scaleX);

    let areaX = elX;
    let areaY = elY;
    let areaW = elW;
    let areaH = elH;

    if (prop.includes("margin-bottom")) {
      areaX = elX;
      areaY = delta > 0 ? elY + elH - deltaPxY : elY + elH;
      areaW = elW;
      areaH = Math.max(16, deltaPxY);
    } else if (prop.includes("margin-top")) {
      areaX = elX;
      areaY = delta > 0 ? elY - deltaPxY : elY;
      areaW = elW;
      areaH = Math.max(16, deltaPxY);
    } else if (prop.includes("padding-top")) {
      areaX = elX;
      areaY = elY;
      areaW = elW;
      areaH = Math.max(16, deltaPxY);
    } else if (prop.includes("padding-bottom")) {
      areaX = elX;
      areaY = Math.max(elY, elY + elH - deltaPxY);
      areaW = elW;
      areaH = Math.max(16, deltaPxY);
    } else if (prop.includes("padding-left")) {
      areaX = elX;
      areaY = elY;
      areaW = Math.max(16, deltaPxX);
      areaH = elH;
    } else if (prop.includes("padding-right")) {
      areaX = Math.max(elX, elX + elW - deltaPxX);
      areaY = elY;
      areaW = Math.max(16, deltaPxX);
      areaH = elH;
    } else if (prop.includes("margin-left")) {
      areaX = delta > 0 ? elX - deltaPxX : elX;
      areaY = elY;
      areaW = Math.max(16, deltaPxX);
      areaH = elH;
    } else if (prop.includes("margin-right")) {
      areaX = elX + elW;
      areaY = elY;
      areaW = Math.max(16, deltaPxX);
      areaH = elH;
    }

    return { areaX, areaY, areaW, areaH, elX, elY, elW, elH, isSpacing: true, delta };
  };

  // Composite Offscreen Renderer for Copy / Export
  const generateCompositeDataUrl = async (): Promise<string | null> => {
    const canvas = canvasRef.current;
    if (!canvas || (!beforeImage && !afterImage)) return null;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return null;

    // Load background images
    const loadImg = (src: string): Promise<HTMLImageElement> =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });

    try {
      if (viewMode === "side" && beforeImage && afterImage) {
        const imgB = await loadImg(beforeImage);
        const imgA = await loadImg(afterImage);
        const halfW = exportCanvas.width / 2 - 6;

        ctx.fillStyle = "#18181c";
        ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

        ctx.drawImage(imgB, 0, 0, halfW, exportCanvas.height);
        ctx.drawImage(imgA, halfW + 12, 0, halfW, exportCanvas.height);
      } else {
        const targetImgSrc = afterImage || beforeImage;
        if (targetImgSrc) {
          const img = await loadImg(targetImgSrc);
          ctx.drawImage(img, 0, 0, exportCanvas.width, exportCanvas.height);
        }
      }

      // Draw change boxes and callout badges onto export canvas
      const targetImgRef = viewMode === "side" ? sideAfterImgRef : baseImgRef;
      const imageEl = targetImgRef.current;
      if (imageEl && uniqueChanges.length > 0) {
        const renderW = imageEl.clientWidth;
        const renderH = imageEl.clientHeight;
        if (renderW > 0 && renderH > 0) {
          uniqueChanges.forEach((change) => {
            const targetRect = change.rectAfter || change.rect || change.rectBefore;
            if (!targetRect || targetRect.width <= 0 || targetRect.height <= 0) return;
            const vw = targetRect.vw || imageEl.naturalWidth || 1920;
            const vh = targetRect.vh || imageEl.naturalHeight || 1080;
            const scaleX = exportCanvas.width / vw;
            const scaleY = exportCanvas.height / vh;

            const prop = (change.property || change.name || change.type || "style").toLowerCase();
            const val = change.value || "";
            const beforeVal = change.beforeValue ? ` (was ${change.beforeValue})` : "";

            const { areaX, areaY, areaW, areaH, elX, elY, elW, elH, isSpacing, delta } = getAreaIncreaseCoords(
              prop,
              val,
              change.beforeValue || "",
              targetRect,
              scaleX,
              scaleY
            );

            const deltaText = delta !== undefined && !isNaN(delta) ? ` [${delta >= 0 ? "+" : ""}${Math.round(delta)}px]` : "";
            const labelText = `${prop.toUpperCase()}: ${val}${beforeVal}${deltaText}`;

            let strokeColor = "#ff0055";
            if (prop.includes("font") || prop.includes("text") || prop.includes("color")) {
              strokeColor = "#f59e0b";
            } else if (prop.includes("width") || prop.includes("height") || prop.includes("display")) {
              strokeColor = "#22c55e";
            }

            if (isSpacing) {
              // Element outline
              ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
              ctx.lineWidth = 1;
              ctx.setLineDash([4, 4]);
              ctx.strokeRect(elX, elY, elW, elH);
              ctx.setLineDash([]);
            }

            // Increased area box
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = 2;
            ctx.setLineDash(isSpacing ? [6, 4] : []);
            ctx.fillStyle = strokeColor + "35";
            ctx.fillRect(areaX, areaY, areaW, areaH);
            ctx.strokeRect(areaX, areaY, areaW, areaH);
            ctx.setLineDash([]);

            // Badge text
            ctx.font = "bold 12px monospace";
            const textMetrics = ctx.measureText(labelText);
            const badgeW = textMetrics.width + 16;
            const badgeH = 22;
            const badgeX = areaX;
            const badgeY = Math.max(10, areaY - badgeH - 4);

            ctx.fillStyle = "#121215";
            ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);

            ctx.fillStyle = strokeColor;
            ctx.fillText(labelText, badgeX + 8, badgeY + 15);
          });
        }
      }

      // Overlay user drawing annotations
      ctx.drawImage(canvas, 0, 0);
      return exportCanvas.toDataURL("image/png");
    } catch (err) {
      console.error("Failed to render composite export canvas:", err);
      return null;
    }
  };

  // Copy to Clipboard
  const handleCopyToClipboard = async () => {
    const dataUrl = await generateCompositeDataUrl();
    if (!dataUrl) return;

    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast("✓ Copied annotated screenshot to clipboard!");
    } catch (err) {
      console.error("Clipboard copy failed:", err);
      showToast("Failed to copy to clipboard");
    }
  };

  // Download PNG
  const handleDownload = async () => {
    const dataUrl = await generateCompositeDataUrl();
    if (!dataUrl) return;

    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `qa-before-after-${Date.now()}.png`;
    a.click();
    showToast("✓ Downloaded annotated PNG!");
  };

  // Save to Snapshots
  const handleSaveToSnapshots = async () => {
    const dataUrl = await generateCompositeDataUrl();
    if (!dataUrl) return;
    if (onSaveSnapshot) {
      onSaveSnapshot(dataUrl, `Before-After Record (${new Date().toLocaleTimeString()})`);
      showToast("✓ Saved to Project Snapshots!");
    }
  };

  // Render On-Image Change Overlays & Badges Pixel-Perfectly
  const renderChangeOverlays = (
    imgRef: React.RefObject<HTMLImageElement | null>,
    isAfterView = false
  ) => {
    if (!uniqueChanges || uniqueChanges.length === 0) return null;

    const imageEl = imgRef.current;
    if (!imageEl) return null;

    const renderW = imageEl.clientWidth;
    const renderH = imageEl.clientHeight;
    if (renderW <= 0 || renderH <= 0) return null;

    return (
      <div className="snipping-image-change-overlay">
        {uniqueChanges.map((change, i) => {
          const prop = (change.property || change.name || change.type || "style").toLowerCase();
          const val = change.value || "";
          const beforeVal = change.beforeValue ? ` (was ${change.beforeValue})` : "";

          let categoryClass = "padding-margin";
          if (prop.includes("font") || prop.includes("text") || prop.includes("color")) {
            categoryClass = "font-text";
          } else if (prop.includes("width") || prop.includes("height") || prop.includes("display")) {
            categoryClass = "dimension-layout";
          }

          const targetRect = isAfterView
            ? (change.rectAfter || change.rect || change.rectBefore)
            : (change.rectBefore || change.rect || change.rectAfter);

          if (!targetRect || targetRect.width <= 0 || targetRect.height <= 0) return null;

          const vw = targetRect.vw || imageEl.naturalWidth || 1920;
          const vh = targetRect.vh || imageEl.naturalHeight || 1080;

          const scaleX = renderW / vw;
          const scaleY = renderH / vh;

          const { areaX, areaY, areaW, areaH, elX, elY, elW, elH, isSpacing, delta } = getAreaIncreaseCoords(
            prop,
            val,
            change.beforeValue || "",
            targetRect,
            scaleX,
            scaleY
          );

          const deltaText = delta !== undefined && !isNaN(delta) ? ` [${delta >= 0 ? "+" : ""}${Math.round(delta)}px]` : "";
          const labelText = `${prop.toUpperCase()}: ${val}${beforeVal}${deltaText}`;

          return (
            <React.Fragment key={i}>
              {/* Element outline for spacing adjustments */}
              {isSpacing && (
                <div
                  className="snipping-element-outline"
                  style={{
                    left: `${elX}px`,
                    top: `${elY}px`,
                    width: `${elW}px`,
                    height: `${elH}px`,
                  }}
                />
              )}

              {/* Increased Area Box */}
              <div
                className={`snipping-change-box ${categoryClass}`}
                style={{
                  left: `${areaX}px`,
                  top: `${areaY}px`,
                  width: `${areaW}px`,
                  height: `${areaH}px`,
                }}
              >
                <div className="snipping-change-badge">
                  <span>{labelText}</span>
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="snipping-modal-overlay">
      <div className="snipping-modal-container">
        {/* Top Header Toolbar */}
        <div className="snipping-toolbar">
          <div className="snipping-title-wrap">
            <span className="snipping-badge">● RECORDED SESSION</span>
            <span className="snipping-title">Before & After Snipping Studio</span>
          </div>

          {/* View Modes */}
          <div className="snipping-tool-group">
            <button
              className={`snipping-mode-btn ${viewMode === "side" ? "active" : ""}`}
              onClick={() => setViewMode("side")}
              title="Side-by-Side View"
            >
              Side-by-Side
            </button>
            <button
              className={`snipping-mode-btn ${viewMode === "wipe" ? "active" : ""}`}
              onClick={() => setViewMode("wipe")}
              title="Interactive Wipe Slider View"
            >
              Wipe Slider
            </button>
          </div>

          {/* Annotation Tools */}
          <div className="snipping-tool-group">
            <button
              className={`snipping-tool-btn ${activeTool === "arrow" ? "active" : ""}`}
              onClick={() => setActiveTool("arrow")}
              title="Arrow Tool"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="5" y1="19" x2="19" y2="5" />
                <polyline points="12 5 19 5 19 12" />
              </svg>
            </button>

            <button
              className={`snipping-tool-btn ${activeTool === "text" ? "active" : ""}`}
              onClick={() => setActiveTool("text")}
              title="Callout Text Box"
            >
              <span style={{ fontSize: 13, fontWeight: 700 }}>T</span>
            </button>

            <button
              className={`snipping-tool-btn ${activeTool === "rect" ? "active" : ""}`}
              onClick={() => setActiveTool("rect")}
              title="Highlight Rectangle"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
            </button>

            <button
              className={`snipping-tool-btn ${activeTool === "circle" ? "active" : ""}`}
              onClick={() => setActiveTool("circle")}
              title="Circle / Ellipse"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="9" />
              </svg>
            </button>

            <button
              className={`snipping-tool-btn ${activeTool === "pen" ? "active" : ""}`}
              onClick={() => setActiveTool("pen")}
              title="Freehand Sketch Brush"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 19l7-7 3 3-7 7-3-3z" />
                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
              </svg>
            </button>

            <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.1)", margin: "0 4px" }} />

            {/* Colors */}
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`snipping-color-swatch ${color === c ? "active" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  title={`Stroke Color ${c}`}
                />
              ))}
            </div>

            <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.1)", margin: "0 4px" }} />

            {/* Undo / Redo / Clear */}
            <button
              className="snipping-tool-btn"
              onClick={handleUndo}
              disabled={annotations.length === 0}
              title="Undo (Ctrl+Z)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 7v6h6" />
                <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
              </svg>
            </button>

            <button
              className="snipping-tool-btn"
              onClick={handleRedo}
              disabled={redoStack.length === 0}
              title="Redo (Ctrl+Y)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 7v6h-6" />
                <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
              </svg>
            </button>

            <button
              className="snipping-tool-btn"
              onClick={handleClear}
              disabled={annotations.length === 0}
              title="Clear Annotations"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>

          {/* Action Buttons */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button className="snipping-action-btn primary" onClick={handleCopyToClipboard} title="Copy to Clipboard">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>Copy Image</span>
            </button>

            <button className="snipping-action-btn" onClick={handleDownload} title="Download PNG">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span>Save PNG</span>
            </button>

            {onSaveSnapshot && (
              <button className="snipping-action-btn" onClick={handleSaveToSnapshots} title="Save to Snapshots">
                <span>+ Save Snapshot</span>
              </button>
            )}

            <button className="snipping-close-btn" onClick={onClose} title="Close Modal (Esc)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Main Workspace Area */}
        <div className="snipping-workspace" ref={workspaceRef}>
          {/* Side-by-Side View */}
          {viewMode === "side" && (
            <div className="snipping-side-container">
              <div className="snipping-side-pane">
                <span className="snipping-pane-header">BEFORE (ORIGINAL)</span>
                <div className="snipping-image-stage">
                  {beforeImage && (
                    <img
                      ref={sideBeforeImgRef}
                      src={beforeImage}
                      alt="Before"
                      className="snipping-pane-image"
                      onLoad={updateImgDimensions}
                    />
                  )}
                  {renderChangeOverlays(sideBeforeImgRef, false)}
                </div>
              </div>
              <div className="snipping-side-pane">
                <span className="snipping-pane-header">AFTER (MODIFIED)</span>
                <div className="snipping-image-stage">
                  {afterImage && (
                    <img
                      ref={sideAfterImgRef}
                      src={afterImage}
                      alt="After"
                      className="snipping-pane-image"
                      onLoad={updateImgDimensions}
                    />
                  )}
                  {renderChangeOverlays(sideAfterImgRef, true)}
                </div>
              </div>
            </div>
          )}

          {/* Wipe Slider View */}
          {viewMode === "wipe" && (
            <div className="snipping-wipe-container">
              <div className="snipping-wipe-wrapper" ref={wipeWrapperRef}>
                {/* Before Image (Base) */}
                {beforeImage && (
                  <img
                    ref={baseImgRef}
                    src={beforeImage}
                    alt="Before"
                    className="snipping-wipe-image"
                    onLoad={updateImgDimensions}
                  />
                )}

                {/* Base Before Change Overlay */}
                {renderChangeOverlays(baseImgRef, false)}

                {/* After Image (Clipped Overlay) */}
                {afterImage && (
                  <div className="snipping-wipe-overlay" style={{ width: `${wipePos}%` }}>
                    <img
                      src={afterImage}
                      alt="After"
                      className="snipping-wipe-image overlay-img"
                      style={
                        imgDimensions
                          ? { width: `${imgDimensions.width}px`, height: `${imgDimensions.height}px`, maxWidth: "none" }
                          : { width: "100%", maxWidth: "none" }
                      }
                    />
                    {/* Clipped After Change Overlay */}
                    {renderChangeOverlays(baseImgRef, true)}
                  </div>
                )}

                {/* Interactive Split Line */}
                <div
                  className="snipping-wipe-line"
                  style={{ left: `${wipePos}%` }}
                  onMouseDown={() => setIsWiping(true)}
                >
                  <div className="snipping-wipe-handle" onMouseDown={() => setIsWiping(true)}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <polyline points="15 18 9 12 15 6" />
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Annotation Overlay Canvas */}
          <canvas
            ref={canvasRef}
            className="snipping-annotation-canvas"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          />

          {/* Floating Toast Notification */}
          {toastMessage && (
            <div className="snipping-toast">
              <span>{toastMessage}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BeforeAfterSnippingModal;
