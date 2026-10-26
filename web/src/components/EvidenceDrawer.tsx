import { useEffect, useRef, useState } from "react";
import { Check, Copy, Database, Fingerprint } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Evidence } from "../types";
import { shortSha, sourceBadges } from "../format";
export function EvidenceDrawer({
  evidence,
  open,
  onClose,
}: {
  evidence: Evidence | null;
  open: boolean;
  onClose: () => void;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const [copy, setCopy] = useState("");
  useEffect(() => setCopy(""), [evidence?.id]);
  const rows = evidence?.sampleRows.slice(0, 5) ?? [];
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus({ preventScroll: true });
        }}
        className="evidence-sheet w-full sm:max-w-2xl overflow-y-auto p-0"
      >
        <SheetHeader className="border-b p-6">
          <div className="eyebrow">
            <Database size={14} /> QUERY EVIDENCE · {evidence?.id}
          </div>
          <SheetTitle className="text-xl pr-5">
            {evidence?.title ?? "Query evidence"}
          </SheetTitle>
          <SheetDescription>
            The query and results behind this answer.
          </SheetDescription>
        </SheetHeader>
        {evidence && (
          <div className="evidence-body">
            <div className="flex flex-wrap gap-2">
              {sourceBadges(evidence.sources).map((s) => (
                <Badge variant="secondary" key={s}>
                  {s}
                </Badge>
              ))}
            </div>
            {evidence.sources.some((s) => s.kind === "FILE: sample") && (
              <p className="sample-note">Meter readings: sample data</p>
            )}
            <dl className="evidence-meta">
              <div>
                <dt>Zetaris run id</dt>
                <dd>{evidence.zetarisRunId}</dd>
              </div>
              <div>
                <dt>Rows returned</dt>
                <dd>{evidence.rowCount.toLocaleString("en-GB")}</dd>
              </div>
              <div>
                <dt>
                  <Fingerprint size={13} /> SHA-256
                </dt>
                <dd title={evidence.resultSha256}>
                  {shortSha(evidence.resultSha256, 20)}
                </dd>
              </div>
            </dl>
            <div className="flex items-center justify-between gap-2">
              <h3>Read-only SQL</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(evidence.sql);
                    setCopy("Copied");
                  } catch {
                    setCopy("Copy unavailable. Select the SQL to copy.");
                  }
                }}
              >
                {copy === "Copied" ? <Check /> : <Copy />}
                {copy === "Copied" ? "Copied" : "Copy SQL"}
              </Button>
            </div>
            <span className="sr-only" role="status">
              {copy}
            </span>
            <pre className="sql">
              <code>{evidence.sql}</code>
            </pre>
            <h3>Result metrics</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Metric</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Unit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(evidence.metrics).map(([k, v]) => (
                  <TableRow key={k}>
                    <TableCell className="whitespace-normal break-all font-mono text-xs">
                      {k}
                    </TableCell>
                    <TableCell>{String(v.value ?? "—")}</TableCell>
                    <TableCell>{v.unit}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <h3>Sample rows</h3>
            <p className="muted small">First {rows.length} returned rows.</p>
            <div className="sample-table">
              <Table>
                <TableHeader>
                  <TableRow>
                    {cols.map((c) => (
                      <TableHead key={c}>{c}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={i}>
                      {cols.map((c) => (
                        <TableCell key={c}>
                          {typeof r[c] === "object"
                            ? JSON.stringify(r[c])
                            : String(r[c] ?? "—")}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <h3>Federated sources</h3>
            {evidence.sources.map((s) => (
              <div key={s.view} className="source-line">
                <code>{s.view}</code>
                <span>{s.kind}</span>
              </div>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
