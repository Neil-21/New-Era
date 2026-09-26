// Dates people read, not dates machines sort. Files keep ISO names
// (2026-09-05.md sorts right and opens fine in Obsidian); only the label
// changes, in whichever style the user picked.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export const DATE_STYLES = [
  ['ordinal', '5th Sep 2026'],
  ['long', '5 September 2026'],
  ['us', 'Sep 5, 2026'],
  ['weekday', 'Sat 5 Sep'],
  ['iso', '2026-09-05'],
];

// Fixed names: ICU's short months drift between versions ("Sep" vs "Sept").
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ordinal(n) {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return n + tail;
}

export function formatDate(d, style = 'ordinal') {
  const month = (form) => (form === 'long' ? MONTHS[d.getMonth()] : MONTHS[d.getMonth()].slice(0, 3));
  const year = d.getFullYear();
  const thisYear = year === new Date().getFullYear();
  switch (style) {
    case 'iso': return `${year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    case 'long': return `${d.getDate()} ${month('long')} ${year}`;
    case 'us': return `${month('short')} ${d.getDate()}, ${year}`;
    // The year is noise for this year's dates, so the short style drops it.
    case 'weekday': return `${DAYS[d.getDay()]} ${d.getDate()} ${month('short')}${thisYear ? '' : ' ' + year}`;
    default: return `${ordinal(d.getDate())} ${month('short')} ${year}`;
  }
}

// "2026-09-05" -> "5th Sep 2026"; anything that is not a bare date is left alone.
export function prettyTitle(text, style) {
  const m = String(text).match(ISO);
  if (!m) return text;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getMonth() !== Number(m[2]) - 1) return text; // 2026-02-31 is not a date
  return formatDate(d, style);
}
