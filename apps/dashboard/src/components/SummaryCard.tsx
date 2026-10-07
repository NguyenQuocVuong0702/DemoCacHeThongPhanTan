import type { ReactNode } from "react";

type SummaryCardProps = {
  icon: ReactNode;
  label: string;
  value: string | number;
  detail: string;
  tone: "cyan" | "blue" | "violet" | "amber";
};

export function SummaryCard({
  icon,
  label,
  value,
  detail,
  tone,
}: SummaryCardProps) {
  return (
    <div className={`summary-card summary-card--${tone}`}>
      <div className="summary-card__topline">
        <span className="summary-card__icon">{icon}</span>
        <span className="summary-card__label">{label}</span>
      </div>
      <div className="summary-card__value">{value}</div>
      <div className="summary-card__detail">{detail}</div>
    </div>
  );
}
