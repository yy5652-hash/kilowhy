import { ArrowUpRight, CloudSun, TrendingUp, Wallet } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { motion, useReducedMotion } from "motion/react";
import { factDisplay } from "../format";
import type { InvestigationResult } from "../types";
import { waterfallBars } from "../lib/bill-model";
export function KpiCards({ result }: { result: InvestigationResult }) {
  const reduced = useReducedMotion();
  const f = (key: string) => factDisplay(result.facts, key) ?? "—";
  const biggest = waterfallBars(result.decomposition, result.facts)
    .filter((b) => !b.total)
    .sort((a, b) => Math.abs(b.gbp) - Math.abs(a.gbp))[0];
  const tariff = result.recommendation.tariff;
  const saving =
    tariff?.ok && tariff.windows
      ? Math.abs(tariff.windows.B.flatMinusAgileGbp)
      : null;
  const cards = [
    {
      label: "Bill change",
      value: f("delta_bill"),
      detail: `${f("delta_bill_pct")} · ${f("bill_A")} → ${f("bill_B")}`,
      icon: TrendingUp,
      tone: "orange-text",
    },
    {
      label: "Biggest driver",
      value: biggest?.display ?? "—",
      detail: `${biggest?.label ?? "—"} · ${biggest?.share ?? "—"} of the change`,
      icon: ArrowUpRight,
      tone: "orange-text",
    },
    {
      label: "Weather",
      value: f("v_weather"),
      detail: `${f("v_weather_share")} of the change`,
      icon: CloudSun,
      tone: "",
    },
    {
      label: "Best saving found",
      value:
        saving === null
          ? "—"
          : tariff?.cheaperInWindowB === "flat"
            ? new Intl.NumberFormat("en-GB", {
                style: "currency",
                currency: "GBP",
              }).format(saving)
            : (factDisplay(result.facts, "flat_minus_agile_B") ??
              `£${saving.toFixed(2)}`),
      detail:
        tariff?.cheaperInWindowB === "flat"
          ? "Flat vs Agile · window B"
          : "Agile vs flat · window B",
      icon: Wallet,
      tone: "teal-text",
    },
  ];
  return (
    <div className="kpi-grid">
      {cards.map((c, i) => (
        <motion.div
          key={`${result.generatedAt}-${c.label}`}
          initial={reduced ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: i * 0.045 }}
        >
          <Card>
            <CardContent className="kpi">
              <div>
                <span>{c.label}</span>
                <c.icon size={17} />
              </div>
              <strong className={c.tone}>{c.value}</strong>
              <p>{c.detail}</p>
            </CardContent>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}
