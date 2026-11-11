"use client";

/** Deep-linkable full workspace page (same content as the global drawer). */
import { use, useEffect } from "react";
import { Workspace } from "@/components/workspace";
import { useApp } from "@/lib/client";

export default function InstrumentPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = use(params);
  const sym = decodeURIComponent(symbol).toUpperCase();
  const { setSymbol } = useApp();
  useEffect(() => {
    setSymbol(sym);
  }, [sym, setSymbol]);
  return <Workspace symbol={sym} />;
}
