import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { MobileLayout } from "@/components/layout/MobileLayout";

export const CONTACT_EMAIL = "contactkanomarket@gmail.com";
export const CONTACT_PHONE = "+234 907 694 4503";

export interface LegalSection {
  heading: string;
  body: ReactNode;
}

/** Shared layout for the privacy policy and terms of service. */
export function LegalPage({ title, updated, intro, sections }: {
  title: string;
  updated: string;
  intro: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <MobileLayout>
      <article className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="font-display text-2xl font-bold text-primary">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Last updated: {updated}</p>
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-foreground">{intro}</div>

        <div className="mt-6 space-y-6">
          {sections.map((section, i) => (
            <section key={section.heading} aria-labelledby={`legal-${i}`}>
              <h2 id={`legal-${i}`} className="text-base font-semibold text-foreground">
                {i + 1}. {section.heading}
              </h2>
              <div className="mt-2 space-y-2 text-sm leading-relaxed text-muted-foreground [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
                {section.body}
              </div>
            </section>
          ))}
        </div>

        <p className="mt-8 border-t pt-4 text-xs text-muted-foreground">
          See also our <Link to="/privacy" className="text-primary underline">Privacy Policy</Link> and{" "}
          <Link to="/terms" className="text-primary underline">Terms of Service</Link>.
        </p>
      </article>
    </MobileLayout>
  );
}
