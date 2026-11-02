/**
 * Drop routing for the workspace window.
 *
 * The Electron renderer and the browser preview receive the same drop event but
 * have different ways to turn it into a target: Electron resolves the real path
 * through the preload bridge (no upload, no copy), while the browser must upload
 * the bytes to the local gateway. Keeping the decision pure makes both branches
 * testable without a DOM.
 */

export type DropPlan =
  | { readonly kind: "open"; readonly path: string }
  | { readonly kind: "upload" }
  | { readonly kind: "reject"; readonly reason: string };

export const MAX_DROP_BYTES = 100 * 1024 * 1024;

export interface DropInput {
  readonly mode: "desktop" | "browser";
  /** True when exactly one file was dropped. */
  readonly singleFile: boolean;
  /** Size of the dropped file in bytes, when the platform exposes it. */
  readonly size: number;
  /** Absolute path resolved by the Electron preload, when available. */
  readonly path: string | null;
}

export function planDrop(input: DropInput): DropPlan {
  if (!input.singleFile) return { kind: "reject", reason: "Drop one file at a time." };
  if (!Number.isFinite(input.size) || input.size <= 0) return { kind: "reject", reason: "The dropped file is empty." };
  if (input.size > MAX_DROP_BYTES) return { kind: "reject", reason: "Choose a binary smaller than 100 MiB." };
  if (input.mode === "desktop") {
    const path = input.path?.trim() ?? "";
    if (path === "") return { kind: "reject", reason: "This desktop build could not determine the dropped file's path. Use Open binary instead." };
    return { kind: "open", path };
  }
  return { kind: "upload" };
}
