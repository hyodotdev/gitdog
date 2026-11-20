import { useTranslation } from "react-i18next";

/** Formats a timestamp relative to now, such as "5 minutes ago". */
export function useRelativeTime() {
  const { i18n } = useTranslation();
  return (timestamp: number) => {
    const format = new Intl.RelativeTimeFormat(i18n.language, {
      numeric: "auto",
    });
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ["day", 86_400],
      ["hour", 3_600],
      ["minute", 60],
    ];
    for (const [unit, size] of units) {
      if (Math.abs(seconds) >= size)
        return format.format(Math.round(seconds / size), unit);
    }
    return format.format(0, "minute");
  };
}
