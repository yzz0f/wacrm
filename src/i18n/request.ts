import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from './locales';

// Best-effort match of an Accept-Language header against our supported
// locales — good enough for a two-locale app, not a full BCP-47 parser.
function localeFromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  const preferred = header
    .split(',')
    .map((part) => part.split(';')[0].trim().toLowerCase());
  for (const tag of preferred) {
    const base = tag.split('-')[0];
    if (isLocale(base)) return base;
  }
  return null;
}

export default getRequestConfig(async () => {
  // Priority: explicit per-user cookie (set via the language switcher in
  // Settings) > browser Accept-Language > deploy-wide env default > 'en'.
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const headerLocale = localeFromAcceptLanguage(
    (await headers()).get('accept-language')
  );
  const envLocale = process.env.NEXT_PUBLIC_APP_LOCALE;

  const locale =
    (cookieLocale && isLocale(cookieLocale) && cookieLocale) ||
    headerLocale ||
    (envLocale && isLocale(envLocale) && envLocale) ||
    defaultLocale;

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages
  };
});
