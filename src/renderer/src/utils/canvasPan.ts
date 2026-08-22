export function mouseButtonMask(button: number): number {
  if (button === 0) return 1;
  if (button === 1) return 4;
  if (button === 2) return 2;
  return 0;
}

export function isMouseButtonHeld(buttons: number, buttonMask: number): boolean {
  return buttonMask !== 0 && (buttons & buttonMask) === buttonMask;
}
