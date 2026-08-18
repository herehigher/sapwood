// #924 AC2 (gate② P2): mounts the REAL `CostBar` at three fixed settled percentages, each in a
// container of a different real pixel width — the non-uniform X scale the pill-cap-inset fix
// depends on differs per width, so varying it here (rather than one fixed size) is what actually
// exercises the measured-width code path, not just its zero-width SSR/happy-dom fallback.
import { createRoot } from "react-dom/client";
import "../../src/app.css";
import { CostBar } from "../../src/components/CostBar.tsx";

// The outline ring is light-theme-only (`--sap-fill-outline`, tokens.css) — the containment test
// needs it visible to measure.
document.documentElement.setAttribute("data-theme", "sapwood");

function Harness() {
  return (
    <div style={{ background: "var(--panel)", padding: "24px", display: "flex", flexDirection: "column", gap: "24px" }}>
      <div data-case="zero" style={{ width: "260px" }}>
        <CostBar settledUsd={0} max={100} label="zero" />
      </div>
      <div data-case="partial" style={{ width: "420px" }}>
        <CostBar settledUsd={37} max={100} label="partial" />
      </div>
      <div data-case="full" style={{ width: "150px" }}>
        <CostBar settledUsd={100} max={100} label="full" />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
