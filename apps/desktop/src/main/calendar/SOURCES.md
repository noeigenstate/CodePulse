# Calendar data and interfaces

This module is synchronous and has no I/O, clock reads or runtime dependencies.
All public Date arguments use the caller's **local year/month/day**. The lunar
calendar and solar-term dates follow the Chinese civil UTC+08:00 convention;
changing the host timezone does not move a published solar term to a different
civil date. ISO weeks use those local fields with UTC arithmetic, avoiding DST.
Supported Gregorian dates are 1900-01-01 through 2100-12-31 inclusive; an invalid
Date or unsupported year throws RangeError. Early 1900 returns lunar year 1899.

`index.ts` exports the requested DeviceCalendar, lunarDate, solarTerm, isoWeek,
buildMonthCalendar and calendarCardFields APIs. LunarDate has numeric year,
month (1–12), day, isLeapMonth, ganzhiYear, zodiac, monthName (including 闰),
dayName and daysInMonth. Ganzhi and zodiac change on lunar New Year's Day.
Traditional festivals are observed in the ordinary month, not again in a leap
month. 除夕 uses the last day of the twelfth lunar month, whether 29 or 30 days.

HolidayTable is a readonly map from YYYY-MM-DD to `{ name, isOffDay }`.
parseHolidayCn accepts either the upstream object or JSON text, validates the
entire year and rejects duplicates/invalid dates/non-boolean flags. Results and
entries are frozen. A supplied table **replaces** the default; to retain other
years, merge `{ ...BUILTIN_HOLIDAYS, ...parseHolidayCn(update) }`. A missing year
has ordinary weekends only, with no guessed statutory holidays. Table names
never supply cell labels. Label precedence is lunar festival, Gregorian
festival, solar term, lunar day; 清明 is the solar-term label. The card helper
returns only id/source/text/calendar; D2 supplies layout and scheduling.

## Lunar and solar-term sources

Retrieved 2026-10-30:

- Hong Kong Observatory (HKO), [Gregorian–lunar conversion tables](https://www.hko.gov.hk/sc/gts/time/conversion.htm),
  all 200 plain-text years 1901–2100:
  `https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T{year}c.txt`.
  Every one of the 73,049 daily rows and all 4,800 solar terms was parsed and
  checked for completeness. data.ts stores lunar New Year, leap month and
  sequential 29/30-day month bits; solar terms use 24 base-36 day digits per year.
  Its header records SHA-256 of the concatenated UTF-8 source files, ordered by
  year. The last month's length in lunar 2100 is completed from the boundary
  source below; only its first day falls within the supported Gregorian range.
- [isee15/Lunar-Solar-Calendar-Converter](https://github.com/isee15/Lunar-Solar-Calendar-Converter),
  Javascript/LunarSolarConverter.js, supplies the lunar 1899/1900 boundary and
  the final month length. Its author also compared the table against Microsoft's
  ChineseLunisolarCalendar. These boundary years were checked day by day against
  Intl independently. Only calendar facts are retained; no converter code runs
  in this module. The original MIT notice is in THIRD-PARTY-NOTICES.txt.
- [6tail/lunar-javascript](https://github.com/6tail/lunar-javascript), lunar.js,
  supplies the 24 solar-term dates for 1900 by astronomical calculation:
  `Solar.fromYmd(1900, 6, 1).getLunar().getJieQiTable()`, selecting that Gregorian
  year. This fills the year before HKO's published table begins. No library is
  bundled or added as a dependency. Its MIT notice is retained as well.

To reproduce: retrieve the HKO files, take every lunar-month-name row as day 1,
and measure successive month starts. Group from each 正月 through the next 正月;
encode 30-day months as set bits, including the leap month in sequence. Take
the two solar-term day numbers per Gregorian month in chronological order.
Use the two boundary sources only where HKO has no daily row. Cross-check every
reconstructed HKO day and then every Gregorian date against Intl.

## Independent Intl cross-check

tests/calendar-lunar.test.ts compares all 73,414 Gregorian days against
`Intl.DateTimeFormat('en-u-ca-chinese', { year: 'numeric', month: 'numeric',
day: 'numeric', timeZone: 'UTC' })`, passing UTC dates made from local fields.
On Node 24.18.0 / ICU 78.3, 447 days in the following 12 intervals disagree.
They are not skipped: each is checked against separately recorded HKO month
starts in the test. Outside these intervals an Intl difference fails the test;
an ICU version that fixes a known disagreement is also accepted.

| Inclusive Gregorian interval | HKO resolution                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| 1917-03-23–1917-05-20        | Leap second month, followed by third month; ICU places the leap month after month 3  |
| 1922-06-25–1922-08-22        | Leap fifth month, followed by sixth month; ICU places the leap month after month 6   |
| 1954-02-03–1954-03-04        | First month starts February 3, not February 4                                        |
| 1955-02-22–1955-03-23        | Second month starts February 22, not February 23                                     |
| 1987-07-26–1987-09-22        | Leap sixth month, followed by seventh month; ICU places the leap month after month 7 |
| 1999-01-17–1999-02-15        | Twelfth month starts January 17, not January 18                                      |
| 2012-08-17–2012-09-15        | Seventh month starts August 17, not August 18                                        |
| 2018-11-07–2018-12-06        | Tenth month starts November 8, not November 7                                        |
| 2027-02-06–2027-03-07        | First month starts February 6, not February 7                                        |
| 2030-02-02–2030-03-03        | First month starts February 3, not February 2                                        |
| 2057-09-28–2057-10-27        | Ninth month starts September 28, not September 29                                    |
| 2070-03-12–2070-04-10        | Second month starts March 12, not March 13                                           |

These are differences between civil-calendar data sources, not timezone shifts
in the module. HKO warns that future near-midnight moon phases/solar terms can
have one-day uncertainty, including the 2057 new moon above, the 2089 and 2097
new moons, and solar terms in 2021/2051/2083/2084. The committed snapshot follows
the published HKO dates. The older converter disagrees with HKO on 2089-09-04
and 2097-08-07; its values are not used for those years.

## Announced mainland China holidays

Checked directly against the State Council General Office notices:

- [2025, 国办发明电〔2024〕12号](https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm),
  2024-11-12: 28 off days and 5 makeup workdays. New Year January 1; Spring
  Festival January 28–February 4 (work January 26 / February 8); Qingming
  April 4–6; Labour Day May 1–5 (work April 27); Dragon Boat May 31–June 2;
  National Day/Mid-Autumn October 1–8 (work September 28 / October 11).
- [2026, 国办发明电〔2025〕7号](https://www.gov.cn/zhengce/content/202511/content_7047090.htm),
  2025-11-04: 33 off days and 6 makeup workdays. New Year January 1–3 (work
  January 4); Spring Festival February 15–23 (work February 14 / 28); Qingming
  April 4–6; Labour Day May 1–5 (work May 9); Dragon Boat June 19–21;
  Mid-Autumn September 25–27; National Day October 1–7 (work September 20 /
  October 10).

The production module never fetches updates. Online policy and integration
belong to D2; subsequent official changes require a replacement table.
