"use client";

import { Check, Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useTransition } from "react";

import { locales, localeNames, LOCALE_COOKIE, type Locale } from "@/i18n/locales";
import { cn } from "@/lib/utils";

/**
 * Language picker — sets a per-user cookie read by src/i18n/request.ts
 * on the next request, then refreshes so server components re-render
 * with the new locale's messages. No URL change: the app doesn't use
 * locale-prefixed routing, so this is the only per-user override.
 */
export function LocaleSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const t = useTranslations("Settings.appearance");

  const pick = useCallback(
    (next: Locale) => {
      if (next === locale) return;
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
      startTransition(() => {
        router.refresh();
      });
    },
    [locale, router],
  );

  return (
    <div className="space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Languages className="size-4 text-muted-foreground" />
        {t("language")}
      </h3>

      <div
        role="radiogroup"
        aria-label={t("language")}
        className="grid max-w-md grid-cols-2 gap-3"
      >
        {locales.map((code) => (
          <button
            key={code}
            type="button"
            role="radio"
            disabled={isPending}
            onClick={() => pick(code)}
            aria-checked={code === locale}
            aria-label={t("useLanguage", { language: localeNames[code] })}
            className={cn(
              "flex items-center gap-3 rounded-lg border bg-card p-4 text-left transition-colors disabled:opacity-60",
              code === locale
                ? "border-primary/60 ring-2 ring-primary/40"
                : "border-border hover:border-border hover:bg-muted/40",
            )}
          >
            <span className="flex-1 text-sm font-semibold text-foreground">
              {localeNames[code]}
            </span>
            {code === locale && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                <Check className="h-3 w-3" />
                {t("active")}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
