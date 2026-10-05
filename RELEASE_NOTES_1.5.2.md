# Parity v1.5.2

## Windows QA agent fix

- Fix Antigravity CLI runs being stopped on Windows when the safety hook could not launch from an application path containing spaces.
- Launch the Windows safety hook through a local batch wrapper with safe path quoting and escaped percent signs.
- Accept both Windows and slash-style paths in Antigravity read permissions and compare Windows paths without case sensitivity.
- Increase the safety-hook timeout from 10 to 30 seconds for slower machines and antivirus startup scans.
- Show the underlying Antigravity hook or tool error when a run is stopped, making account and environment problems easier to diagnose.

## Verification

- Add unit coverage for Windows hook generation, permission paths, batch wrapper creation, percent escaping, and failure messages.
- Keep the full Windows desktop, QA-agent, OpenCV, viewer, and Supabase migration checks in the release gate.
