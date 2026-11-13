type Where = { locale?: string; timeZone?: string };

const formatter = ({ locale, timeZone }: Where) =>
  new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  });

const viewers = formatter({});

/**
 * The one rule for a time on screen: the viewer's own local time, with their
 * zone's abbreviation. `where` is for tests; screens leave it out.
 */
export function formatTime(iso: string, where?: Where): string {
  const when = where === undefined ? viewers : formatter(where);
  return when.format(new Date(iso));
}

/** Date only, using the same local calendar as formatTime. */
export function formatDate(iso: string, where: Where = {}): string {
  return new Intl.DateTimeFormat(where.locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: where.timeZone,
  }).format(new Date(iso));
}
