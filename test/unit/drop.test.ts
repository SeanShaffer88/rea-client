import { describe, expect, it } from "vitest";
import { MAX_DROP_BYTES, planDrop } from "../../desktop/ui/drop.js";

describe("drop routing", () => {
  it("opens the dropped file in place on desktop when the path resolves", () => {
    expect(planDrop({ mode: "desktop", singleFile: true, size: 1024, path: "/usr/bin/ls" })).toEqual({
      kind: "open",
      path: "/usr/bin/ls",
    });
    expect(planDrop({ mode: "desktop", singleFile: true, size: 1024, path: "  C:\\samples\\a.exe  " })).toEqual({
      kind: "open",
      path: "C:\\samples\\a.exe",
    });
  });

  it("refuses to guess a desktop path rather than silently uploading", () => {
    for (const path of [null, "", "   "]) {
      const plan = planDrop({ mode: "desktop", singleFile: true, size: 1024, path });
      expect(plan.kind).toBe("reject");
      expect(plan.kind === "reject" ? plan.reason : "").toContain("Use Open binary");
    }
  });

  it("uploads in the browser preview, where no real path exists", () => {
    expect(planDrop({ mode: "browser", singleFile: true, size: 1024, path: null })).toEqual({ kind: "upload" });
    // A stray path in browser mode never becomes an open-in-place shortcut.
    expect(planDrop({ mode: "browser", singleFile: true, size: 1024, path: "/etc/passwd" })).toEqual({ kind: "upload" });
  });

  it("rejects multiple files, empty files, and oversized files", () => {
    expect(planDrop({ mode: "browser", singleFile: false, size: 1024, path: null }).kind).toBe("reject");
    expect(planDrop({ mode: "browser", singleFile: true, size: 0, path: null })).toEqual({
      kind: "reject",
      reason: "The dropped file is empty.",
    });
    expect(planDrop({ mode: "browser", singleFile: true, size: Number.NaN, path: null }).kind).toBe("reject");
    expect(planDrop({ mode: "desktop", singleFile: true, size: MAX_DROP_BYTES + 1, path: "/usr/bin/ls" }).kind).toBe("reject");
    expect(planDrop({ mode: "desktop", singleFile: true, size: MAX_DROP_BYTES, path: "/usr/bin/ls" }).kind).toBe("open");
  });
});
