import { describe, expect, it } from "vitest";
import { deriveMaintenanceStatus } from "../src/db/maintenance";

describe("deriveMaintenanceStatus", () => {
  it("is 'scheduled' when the due date is well in the future", () => {
    expect(deriveMaintenanceStatus("2026-06-01", null, "2026-03-01")).toBe("scheduled");
  });

  it("is 'due_soon' within the 14-day window", () => {
    expect(deriveMaintenanceStatus("2026-03-10", null, "2026-03-01")).toBe("due_soon");
  });

  it("is 'due_soon' at exactly the 14-day boundary", () => {
    expect(deriveMaintenanceStatus("2026-03-15", null, "2026-03-01")).toBe("due_soon");
  });

  it("is 'scheduled' one day past the 14-day boundary", () => {
    expect(deriveMaintenanceStatus("2026-03-16", null, "2026-03-01")).toBe("scheduled");
  });

  it("is 'overdue' once the due date has passed with nothing completed", () => {
    expect(deriveMaintenanceStatus("2026-02-20", null, "2026-03-01")).toBe("overdue");
  });

  it("is 'done' whenever completed_at is set, regardless of due date", () => {
    expect(deriveMaintenanceStatus("2026-02-20", "2026-02-25 00:00:00", "2026-03-01")).toBe("done");
    expect(deriveMaintenanceStatus("2027-01-01", "2026-02-25 00:00:00", "2026-03-01")).toBe("done");
  });
});
