import type { ReactNode } from "react";

/**
 * Standard feature-page header — uppercase eyebrow over a display-font title,
 * with an optional actions slot on the right. Uses the .tt-eyebrow /
 * .tt-page-title classes from global.css so styling stays token-driven.
 */
export function PageHeader({
  eyebrow,
  title,
  extra,
}: {
  eyebrow?: string;
  title: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="tt-page-header">
      <div>
        {eyebrow && <div className="tt-eyebrow">{eyebrow}</div>}
        <h1 className="tt-page-title">{title}</h1>
      </div>
      {extra && <div className="tt-page-header__extra">{extra}</div>}
    </div>
  );
}
