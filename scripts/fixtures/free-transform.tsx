import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  installEditBetaBridge,
  SelectionOverlay,
} from "../../src/renderer/src/components/EditBetaWorkspace";

document.body.insertAdjacentHTML(
  "afterbegin",
  `<style>
    body { margin: 0; font-family: sans-serif; }
    #fixture-page { position: absolute; left: 80px; top: 120px; }
    #target { width: 160px; height: 80px; padding: 8px; background: #7950f2; transform: rotate(2deg); transform-origin: 25% 75%; }
    #sibling { width: 160px; height: 32px; margin-top: 18px; background: #ced4da; }
    #overlay-root { position: absolute; inset: 0; z-index: 100; pointer-events: none; }
  </style>
  <main id="fixture-page">
    <div id="target"><strong>Transform all content</strong></div>
    <div id="sibling">Reserved layout sibling</div>
    <span id="inline">Inline target</span>
  </main>`,
);

installEditBetaBridge();
const api = (window as any).__fullForceEditBeta;
api.setOptions({
  revealAnimations: false,
  fontInspectorMode: "off",
  fontInspectorTransparency: 25,
  fontInspectorScale: 100,
  hotkeys: {},
  annotateMode: false,
  boundaries: {
    enabled: false,
    scope: "selected",
    showMargins: false,
    showPaddings: false,
    showDimensions: false,
    showGaps: false,
  },
  rulers: { guidesEnabled: false, guides: [] },
  zoomScale: 1,
  accentColor: "#a855f7",
});

function Harness() {
  const [selected, setSelected] = useState(() => api.selectPath("#target"));
  const [altHeld, setAltHeld] = useState(false);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "Alt") setAltHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Alt") setAltHeld(false);
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    (window as any).__freeTransformSelect = (path: string) => {
      const next = api.selectPath(path);
      setSelected(next);
      return next;
    };
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, []);

  if (!selected) return null;
  return (
    <SelectionOverlay
      selected={selected}
      scale={1}
      boundaries={{
        enabled: false,
        scope: "selected",
        showMargins: false,
        showPaddings: false,
        showDimensions: false,
        showGaps: false,
      }}
      fontFamilies={[]}
      altHeld={altHeld}
      onFreeTransformBegin={async (operation, horizontal, vertical) =>
        api.beginFreeTransform(
          operation,
          horizontal,
          vertical,
          selected.path,
          selected.freeTransform.generation,
        )
      }
      onFreeTransformPreview={async (token, generation, path, delta) => {
        const next = api.previewFreeTransform(token, generation, path, delta);
        if (next) setSelected(next);
        return next;
      }}
      onFreeTransformCommit={async (token, generation, path) => {
        const next = api.commitFreeTransform(token, generation, path);
        if (next) setSelected(next);
        return next;
      }}
      onFreeTransformCancel={async (token, generation, path) => {
        api.cancelFreeTransform(token, generation, path);
        setSelected(api.getState().selected);
      }}
      onFreeTransformReset={async () => {
        const next = api.resetFreeTransform();
        if (next) setSelected(next);
        return next;
      }}
      onFreeTransformActivity={(active) => {
        (window as any).__freeTransformGestureActive = active;
      }}
      onResize={() => undefined}
      onBoxChange={() => undefined}
      onCssDimensionChange={() => undefined}
      onTextStyle={() => undefined}
      onReorder={() => undefined}
      onAction={() => undefined}
      onAnnotate={() => undefined}
    />
  );
}

createRoot(document.getElementById("overlay-root")!).render(<Harness />);
