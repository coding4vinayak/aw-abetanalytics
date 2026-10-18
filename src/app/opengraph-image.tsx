import { ImageResponse } from "next/og";

// The card people see when a AbetAnalytics link lands in WhatsApp, email, or
// LinkedIn — before the click. Generated at build time; no binary asset, so
// the tagline here is the product's own copy and the price is the pricing
// page's price.
export const alt = "AbetAnalytics — metrics, funnels and immutable snapshots with definitions attached";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "linear-gradient(135deg, #0b1220 0%, #1e293b 55%, #312e81 100%)",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: "#4f46e5",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 30,
            }}
          >
            A
          </div>
          <div style={{ fontSize: 32 }}>Abetworks</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 88, letterSpacing: "-0.03em" }}>AbetAnalytics</div>
          <div style={{ fontSize: 38, color: "#c7d2fe" }}>Metrics, funnels and immutable snapshots with definitions attached</div>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 28,
            color: "#94a3b8",
          }}
        >
          <div>analytics.abetworks.in</div>
          <div>$19/mo · 14-day free trial</div>
        </div>
      </div>
    ),
    { ...size }
  );
}
