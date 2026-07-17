import { createContext, useContext, useMemo, type ReactNode } from "react";
import { enDictionary, zhDictionary, type Dictionary } from "./dictionary";
import type { LocaleSetting, ResolvedLocale } from "../desktop-state";

export interface I18nContextValue {
  readonly locale: LocaleSetting;
  readonly resolvedLocale: ResolvedLocale;
  readonly t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const DICTIONARIES: Record<ResolvedLocale, Dictionary> = {
  en: enDictionary,
  zh: zhDictionary,
};

/** Replace {name} placeholders in a template with provided params. */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value !== undefined ? String(value) : match;
  });
}

/** Translate a key for the given locale, falling back to English then the key itself. */
export function translate(
  locale: ResolvedLocale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const dict = DICTIONARIES[locale];
  const template = dict[key] ?? enDictionary[key] ?? key;
  return interpolate(template, params);
}

export function I18nProvider({
  locale,
  resolvedLocale,
  children,
}: {
  readonly locale: LocaleSetting;
  readonly resolvedLocale: ResolvedLocale;
  readonly children: ReactNode;
}) {
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      resolvedLocale,
      t: (key, params) => translate(resolvedLocale, key, params),
    }),
    [locale, resolvedLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return ctx;
}