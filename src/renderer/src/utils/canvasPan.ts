export function mouseButtonMask(button: number): number {
  if (button === 0) return 1;
  if (button === 1) return 4;
  if (button === 2) return 2;
  return 0;
}

export function isMouseButtonHeld(buttons: number, buttonMask: number): boolean {
  return buttonMask !== 0 && (buttons & buttonMask) === buttonMask;
}

export function isCanvasPanGesture(
  button: number,
  spacePressed: boolean,
  allowSpacePan = true,
): boolean {
  // Middle mouse is reserved for canvas panning in every canvas interaction
  // mode. Space + primary click remains opt-in so text/site interaction modes
  // can retain their normal primary-button behavior.
  return button === 1 || (allowSpacePan && button === 0 && spacePressed);
}
