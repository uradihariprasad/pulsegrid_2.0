"use client";

/**
 * PULSEGRID 2.0 — chart surfaces.
 * CandleChart uses TradingView Lightweight Charts with panes:
 *   pane 0 candles + EMA/VWAP/BB overlays + S/R price lines
 *   pane 1 volume
 *   pane 2 FMPI (recalculated per instrument+timeframe by the backend)
 */
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { fmt, type J } from "@/lib/client";

const IST = 19_800; // seconds offset so displayed times are IST

function toTs(ms: number): UTCTimestamp {
  return Math.round((ms + IST * 1000) / 1000) as UTCTimestamp;
}

/** IST calendar day of an epoch-ms timestamp. */
function istDay(ms: number): string {
  return new Date(ms + IST * 1000).toISOString().slice(0, 10);
}

export interface SROverlay {
  price: number;
  color: string;
  title: string;
  style?: "solid" | "dashed" | "dotted";
  width?: 1 | 2 | 3;
  /** optional zone band drawn as two faint edges */
  zoneLow?: number;
  zoneHigh?: number;
}

/**
 * Volume-profile overlays. Prices are ALWAYS in the spot scale — for indices
 * the store has already basis-shifted the futures levels, so no raw futures
 * price can reach the spot chart.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function overlaysFromProfile(vp: any): SROverlay[] {
  if (!vp || !Number.isFinite(vp.poc)) return [];
  const out: SROverlay[] = [
    { price: vp.poc, color: "#4fa3ff", title: `POC ${fmt(vp.poc)}`, style: "solid", width: 1 },
    { price: vp.vah, color: "rgba(79,163,255,0.55)", title: `VAH ${fmt(vp.vah)}`, style: "dashed", width: 1 },
    { price: vp.val, color: "rgba(79,163,255,0.55)", title: `VAL ${fmt(vp.val)}`, style: "dashed", width: 1 },
  ];
  for (const h of (vp.hvn ?? []).slice(0, 2)) out.push({ price: h, color: "rgba(139,92,246,0.5)", title: `HVN ${fmt(h)}`, style: "dotted", width: 1 });
  for (const l of (vp.lvn ?? []).slice(0, 2)) out.push({ price: l, color: "rgba(240,185,11,0.45)", title: `LVN ${fmt(l)}`, style: "dotted", width: 1 });
  return out.filter((o) => Number.isFinite(o.price));
}

/** Build chart overlays straight from the unified S/R engine output. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function overlaysFromLevels(levels: any[] | null | undefined): SROverlay[] {
  if (!levels?.length) return [];
  return levels
    .filter((l) => l && Number.isFinite(l.price))
    .map((l) => ({
      price: l.price,
      color: l.style?.color ?? (l.side === "RESISTANCE" ? "#ea3943" : "#16c784"),
      title: l.style?.label ?? `${l.role?.slice(0, 2) ?? ""} ${l.price}`,
      style: (l.style?.dash ?? "solid") as "solid" | "dashed" | "dotted",
      width: (l.style?.width ?? 2) as 1 | 2 | 3,
      zoneLow: l.zoneLow,
      zoneHigh: l.zoneHigh,
    }));
}

export function CandleChart({
  data,
  height = 380,
  overlays = [],
  fmpi,
  showVolume = true,
}: {
  data: J | null;
  height?: number;
  overlays?: SROverlay[];
  fmpi?: { ts: number; value: number }[] | null;
  showVolume?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fmpiRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lineRefs = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const priceLinesRef = useRef<IPriceLine[]>([]);
  /** instrument+timeframe currently rendered — a change means "re-fit" */
  const scopeRef = useRef<string>("");
  const [userZoomed, setUserZoomed] = useState(false);
  const userZoomedRef = useRef(false);

  const scope = data ? `${data.symbol}|${data.tf}` : "";

  /* ------------------------------------------------------------ create once */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#7d8aa0",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: { vertLines: { color: "rgba(30,38,52,0.5)" }, horzLines: { color: "rgba(30,38,52,0.5)" } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "#1e2634", autoScale: true },
      timeScale: { borderColor: "#1e2634", timeVisible: true, secondsVisible: false, rightOffset: 4 },
      // full zoom / pan including touch pinch for mobile
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true, axisDoubleClickReset: true },
      width: el.clientWidth,
      height,
    });
    chartRef.current = chart;

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: "#16c784",
      downColor: "#ea3943",
      borderVisible: false,
      wickUpColor: "#16c784",
      wickDownColor: "#ea3943",
    });

    const mkLine = (key: string, color: string, width: 1 | 2, dash: boolean, pane = 0) => {
      const ls = chart.addSeries(
        LineSeries,
        { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, lineStyle: dash ? LineStyle.Dashed : LineStyle.Solid },
        pane,
      );
      lineRefs.current.set(key, ls);
    };
    mkLine("ema9", "#4fa3ff", 1, false);
    mkLine("ema21", "#f0b90b", 1, false);
    mkLine("ema34", "#8b5cf6", 1, false);
    mkLine("ema200", "#5a6a83", 1, false);
    mkLine("bbUp", "rgba(122,138,160,0.45)", 1, true);
    mkLine("bbDn", "rgba(122,138,160,0.45)", 1, true);
    mkLine("vwap", "#f0b90b", 1, true);

    if (showVolume) {
      volRef.current = chart.addSeries(
        HistogramSeries,
        { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false },
        1,
      );
      volRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0 } });
    }
    fmpiRef.current = chart.addSeries(
      LineSeries,
      { color: "#4fa3ff", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: "FMPI" },
      showVolume ? 2 : 1,
    );
    fmpiRef.current.createPriceLine({ price: 0, color: "#1e2634", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: "" });

    const panes = chart.panes();
    panes[0]?.setStretchFactor(showVolume ? 16 : 20);
    if (showVolume) panes[1]?.setStretchFactor(4);
    panes[showVolume ? 2 : 1]?.setStretchFactor(7);

    // remember that the user has taken manual control of the viewport
    const onRange = () => {
      if (!userZoomedRef.current) {
        userZoomedRef.current = true;
        setUserZoomed(true);
      }
    };
    let armed = false;
    const arm = setTimeout(() => {
      armed = true;
    }, 1200);
    const handler = () => {
      if (armed) onRange();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);

    const ro = new ResizeObserver(() => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    });
    ro.observe(el);

    return () => {
      clearTimeout(arm);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      fmpiRef.current = null;
      lineRefs.current.clear();
      priceLinesRef.current = [];
      scopeRef.current = "";
    };
    // created ONCE for the component's lifetime (per showVolume layout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVolume]);

  /* ------------------------------------------------- height stays reactive */
  useEffect(() => {
    chartRef.current?.applyOptions({ height, width: ref.current?.clientWidth ?? undefined });
  }, [height]);

  /* ------------------------------------------- update data WITHOUT re-creating */
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleRef.current;
    if (!chart || !series || !data?.candles?.length) return;

    const candles = data.candles as { ts: number; o: number; h: number; l: number; c: number; v: number }[];
    const scopeChanged = scopeRef.current !== scope;

    // keep the user's viewport across refreshes
    const prevRange = chart.timeScale().getVisibleLogicalRange();

    series.setData(candles.map((c) => ({ time: toTs(c.ts), open: c.o, high: c.h, low: c.l, close: c.c })));

    const ind = data.indicators ?? {};
    const apply = (key: string, pts: { ts: number; v: number }[] | undefined) => {
      const ls = lineRefs.current.get(key);
      if (!ls) return;
      ls.setData((pts ?? []).map((p) => ({ time: toTs(p.ts), value: p.v })));
    };
    apply("ema9", ind.ema9);
    apply("ema21", ind.ema21);
    apply("ema34", ind.ema34);
    apply("ema200", ind.ema200);
    apply("bbUp", ind.bbUp);
    apply("bbDn", ind.bbDn);

    // session VWAP only spans the most recent session
    if (typeof ind.vwap === "number" && candles.length) {
      const lastDay = istDay(candles[candles.length - 1].ts);
      apply(
        "vwap",
        candles.filter((c) => istDay(c.ts) === lastDay).map((c) => ({ ts: c.ts, v: ind.vwap as number })),
      );
    } else apply("vwap", []);

    if (volRef.current) {
      volRef.current.setData(
        candles.map((c) => ({ time: toTs(c.ts), value: c.v, color: c.c >= c.o ? "rgba(22,199,132,0.35)" : "rgba(234,57,67,0.35)" })),
      );
    }
    if (fmpiRef.current) {
      fmpiRef.current.setData((fmpi ?? []).map((p) => ({ time: toTs(p.ts), value: p.value })));
    }

    if (scopeChanged) {
      // new instrument / timeframe → start from a clean, fitted viewport
      scopeRef.current = scope;
      userZoomedRef.current = false;
      setUserZoomed(false);
      chart.timeScale().fitContent();
    } else if (prevRange) {
      // same instrument → RESTORE the user's zoom/pan instead of refitting
      chart.timeScale().setVisibleLogicalRange(prevRange);
    }
  }, [data, fmpi, scope]);

  /* ----------------------------------------- overlays update independently */
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const pl of priceLinesRef.current) {
      try {
        series.removePriceLine(pl);
      } catch {
        /* already detached */
      }
    }
    priceLinesRef.current = [];
    for (const ov of overlays) {
      if (ov.zoneLow != null && ov.zoneHigh != null && ov.zoneHigh - ov.zoneLow > 0) {
        for (const edge of [ov.zoneLow, ov.zoneHigh]) {
          if (Math.abs(edge - ov.price) < 1e-6) continue;
          priceLinesRef.current.push(
            series.createPriceLine({ price: edge, color: ov.color, lineWidth: 1, lineStyle: LineStyle.SparseDotted, axisLabelVisible: false, title: "" }),
          );
        }
      }
      priceLinesRef.current.push(
        series.createPriceLine({
          price: ov.price,
          color: ov.color,
          lineWidth: (ov.width ?? 2) as 1 | 2 | 3 | 4,
          lineStyle: ov.style === "dotted" ? LineStyle.SparseDotted : ov.style === "dashed" ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true,
          title: ov.title,
        }),
      );
    }
  }, [overlays]);

  const resetZoom = () => {
    chartRef.current?.timeScale().fitContent();
    userZoomedRef.current = false;
    setUserZoomed(false);
  };

  const hasData = !!data?.candles?.length;

  // IMPORTANT: the chart container is ALWAYS mounted, even while data is
  // loading. The chart instance is created once against this stable element;
  // when data arrives the update effect fills the existing series. Returning a
  // different placeholder tree here would make the one-time creation effect
  // miss its ref and leave a permanently blank chart.
  return (
    <div className="relative w-full" style={{ minHeight: height }}>
      <div
        ref={ref}
        className={`w-full touch-pan-y transition-opacity ${hasData ? "opacity-100" : "opacity-0"}`}
        style={{ height }}
        data-chart-scope={scope || "loading"}
      />
      {!hasData && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-[11px] text-grey">
          <span className="h-1.5 w-1.5 animate-ping rounded-full bg-blue" />
          Building candles from Upstox…
        </div>
      )}
      {hasData && userZoomed && (
        <button
          onClick={resetZoom}
          className="absolute right-2 top-2 z-10 rounded border border-border bg-panel/90 px-2 py-0.5 text-[9.5px] font-semibold text-txt-dim backdrop-blur hover:border-blue/50 hover:text-blue"
        >
          Reset zoom
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- OI bars --- */
export interface OIBarRow {
  label: string;
  ce: number | null;
  pe: number | null;
  highlight?: boolean;
}

/** Diverging CE/PE bar chart around zero (change charts) or absolute. */
export function OIBars({ rows, absolute = false, height = 150 }: { rows: OIBarRow[]; absolute?: boolean; height?: number }) {
  const vals = rows.flatMap((r) => [r.ce, r.pe].filter((v): v is number => v != null).map(Math.abs));
  const max = Math.max(1e-9, ...vals);
  const plotH = height - 26;
  const zeroY = absolute ? plotH : plotH / 2;
  return (
    <div className="w-full overflow-x-auto">
      <svg width={Math.max(rows.length * 46, 240)} height={height} className="mx-auto block">
        <line x1={0} x2="100%" y1={zeroY + 0.5} y2={zeroY + 0.5} stroke="#1e2634" />
        {rows.map((r, i) => {
          const gx = i * 46 + 8;
          const bar = (v: number | null, x: number, kind: "ce" | "pe") => {
            if (v == null) return <text key={kind} x={x + 6} y={zeroY - 2} fontSize={7} fill="#5a6a83" textAnchor="middle">N/A</text>;
            const hAbs = absolute ? (Math.abs(v) / max) * (plotH - 6) : (Math.abs(v) / max) * (plotH / 2 - 6);
            const up = v >= 0;
            const y = absolute ? zeroY - hAbs : up ? zeroY - hAbs : zeroY + 1;
            const color = absolute ? (kind === "ce" ? "#4fa3ff" : "#f0b90b") : up ? "#16c784" : "#ea3943";
            return <rect key={kind} x={x} y={y} width={12} height={Math.max(hAbs, 1)} rx={1.5} fill={color} opacity={r.highlight ? 1 : 0.8} />;
          };
          return (
            <g key={r.label + i}>
              {bar(r.ce, gx, "ce")}
              {bar(r.pe, gx + 14, "pe")}
              {r.highlight && <rect x={gx - 4} y={2} width={38} height={height - 22} rx={3} fill="rgba(79,163,255,0.06)" stroke="rgba(79,163,255,0.25)" />}
              <text x={gx + 13} y={height - 12} fontSize={8} fill={r.highlight ? "#4fa3ff" : "#7d8aa0"} textAnchor="middle" fontWeight={r.highlight ? 700 : 400}>
                {r.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center justify-center gap-3 text-[9px] text-txt-dim">
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-blue inline-block" /> CE (ATM−{Math.floor(rows.length / 2)} … ATM+{Math.floor(rows.length / 2)})</span>
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-amber inline-block" /> PE</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ FMPI gauge - */
export function FMPIGauge({ value }: { value: number }) {
  const v = Math.max(-100, Math.min(100, value));
  const left = ((v + 100) / 200) * 100;
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full" style={{ background: "linear-gradient(90deg,#ea3943,#3a2a2e 30%,#151b25 50%,#123129 70%,#16c784)" }}>
      <div className="absolute top-1/2 h-3.5 w-[3px] -translate-y-1/2 rounded bg-white shadow" style={{ left: `calc(${left}% - 1.5px)` }} />
    </div>
  );
}

export function Sparkline({ points, width = 96, height = 26, color }: { points: number[]; width?: number; height?: number; color?: string }) {
  if (!points || points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, 1e-9);
  const d = points.map((p, i) => `${(i / (points.length - 1)) * width},${height - 2 - ((p - min) / span) * (height - 4)}`).join(" ");
  const c = color ?? (points[points.length - 1] >= points[0] ? "#16c784" : "#ea3943");
  return (
    <svg width={width} height={height}>
      <polyline points={d} fill="none" stroke={c} strokeWidth={1.2} />
    </svg>
  );
}

export { fmt };
