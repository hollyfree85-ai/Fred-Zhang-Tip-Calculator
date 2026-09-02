(function attachFredTipCalculatorLogic(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.FredTipCalculatorLogic = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function createFredTipCalculatorLogic() {
  "use strict";

  const roster = Object.freeze([
    "Adrieanna Walker",
    "Aida Gonzales",
    "Alainna Montalvo",
    "Angela Grizzad",
    "Ariana Garner",
    "Ashley Garcia",
    "Brandi Copeland",
    "Caitlin Dillon",
    "Christina Gurley",
    "Dorothy Makovicka",
    "Fred Zhang",
    "Hannah Dempsey",
    "Jesus Ovalle-Munoz",
    "Libby Lane",
    "Megan Meadows",
    "Megan Sisk",
    "Mia Burress",
    "Sara Swift",
    "Sarah Kibler"
  ]);

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function roundCent(value) {
    const number = finiteNumber(value, 0);
    const scaled = number * 100;
    return Math.round(scaled + Math.sign(scaled || 1) * 1e-7) / 100;
  }

  function parseMoney(value, fallback) {
    const safeFallback = arguments.length > 1 ? finiteNumber(fallback, 0) : 0;
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : safeFallback;
    }
    if (value === null || value === undefined) {
      return safeFallback;
    }

    let text = String(value).trim();
    if (!text) {
      return safeFallback;
    }

    const parenthesized = /^\(.*\)$/.test(text);
    text = text
      .replace(/[,$\s]/g, "")
      .replace(/^\((.*)\)$/, "$1");
    const number = Number(text);
    if (!Number.isFinite(number)) {
      return safeFallback;
    }
    return parenthesized ? -Math.abs(number) : number;
  }

  /**
   * Lightweight input mask for the typed-time fields. It intentionally does
   * not validate or guess a time; validation remains parseTypedTime's job.
   */
  function formatTimeDigits(value) {
    const digits = String(value === null || value === undefined ? "" : value)
      .replace(/\D/g, "")
      .slice(0, 4);
    if (digits.length < 2) {
      return digits;
    }
    return `${digits.slice(0, 2)}:${digits.slice(2)}`;
  }

  /**
   * Parses typed time into minutes after midnight.
   * Accepted examples: 10:30 AM, 10.30am, 1030 PM, 22:15, 2215, 9 PM.
   * Returns null when the value is incomplete or invalid.
   */
  function parseTypedTime(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      value = String(value);
    }
    if (value === null || value === undefined) {
      return null;
    }

    const text = String(value)
      .trim()
      .toUpperCase()
      .replace(/\s+/g, " ");
    if (!text) {
      return null;
    }

    const match = text.match(/^(\d{1,2})(?:(?::|\.)(\d{1,2})|(\d{2}))?\s*(AM|PM)?$/);
    let hour;
    let minute;
    let meridiem;

    if (match) {
      hour = Number(match[1]);
      minute = Number(match[2] || match[3] || 0);
      meridiem = match[4] || "";
    } else {
      const compact = text.match(/^(\d{3,4})\s*(AM|PM)?$/);
      if (!compact) {
        return null;
      }
      const digits = compact[1];
      hour = Number(digits.slice(0, -2));
      minute = Number(digits.slice(-2));
      meridiem = compact[2] || "";
    }

    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      return null;
    }

    if (meridiem) {
      if (hour < 1 || hour > 12) {
        return null;
      }
      if (hour === 12) {
        hour = 0;
      }
      if (meridiem === "PM") {
        hour += 12;
      }
    } else if (hour < 0 || hour > 23) {
      return null;
    }

    return hour * 60 + minute;
  }

  /**
   * Normalizes a complete accepted time to HH:MM. Partial/invalid text is
   * returned as a visible mask (or blank) so no valid time is invented.
   */
  function to24Hour(value) {
    const text = String(value === null || value === undefined ? "" : value).trim();
    if (!text) {
      return "";
    }

    const hasMeridiem = /(?:^|\s)(?:AM|PM)$/i.test(text);
    const compactDigits = text.replace(/\D/g, "").slice(0, 4);
    const separatorMatch = text.match(/[:.](\d*)/);

    // With the digit mask, three compact digits or fewer than two digits
    // after a separator are still being typed. Preserve that state.
    if (!hasMeridiem && !separatorMatch && compactDigits.length < 4) {
      return formatTimeDigits(compactDigits);
    }
    if (separatorMatch && separatorMatch[1].length < 2) {
      return text;
    }

    const minutes = parseTypedTime(text);
    if (minutes === null) {
      return formatTimeDigits(text);
    }
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function normalizeShift(value) {
    const shift = String(value || "").trim().toUpperCase();
    if (shift === "DOUBLE") return "DOUBLE";
    if (shift === "PM") return "PM";
    return "AM";
  }

  function normalizePosition(value) {
    const position = String(value || "").trim().toLowerCase();
    return position === "bartender" || position === "bar" ? "Bartender" : "Server";
  }

  function normalizeBusserAM(value) {
    if (value === true) return "WITH";
    if (value === false) return "WITHOUT";
    const normalized = String(value || "").trim().toUpperCase();
    return normalized.includes("WITHOUT") ? "WITHOUT" : "WITH";
  }

  function elapsedMinutes(hourIn, hourOut) {
    const start = parseTypedTime(hourIn);
    const end = parseTypedTime(hourOut);
    if (start === null || end === null) {
      return null;
    }
    let difference = end - start;
    if (difference < 0) {
      difference += 24 * 60;
    }
    return difference;
  }

  /**
   * Returns the exact elapsed whole minutes represented by the clock fields.
   * Keeping minutes as the source of truth prevents rounded display hours from
   * affecting wage calculations.
   */
  function calculateTotalMinutes(shift, hours) {
    const normalizedShift = normalizeShift(shift);
    const values = hours || {};
    if (normalizedShift !== "DOUBLE") {
      return elapsedMinutes(values.hourIn, values.hourOut);
    }

    const amMinutes = elapsedMinutes(values.hourInAM, values.hourOutAM);
    const pmMinutes = elapsedMinutes(values.hourInPM, values.hourOutPM);
    if (amMinutes === null || pmMinutes === null) {
      return null;
    }
    return amMinutes + pmMinutes;
  }

  /**
   * calculateTotalHours("AM", {hourIn: "10 AM", hourOut: "4 PM"})
   * calculateTotalHours("DOUBLE", {hourInAM, hourOutAM, hourInPM, hourOutPM})
   *
   * The returned number is intentionally not rounded. The UI may display it
   * with two decimals, but calculations must retain the exact minute fraction.
   */
  function calculateTotalHours(shift, hours) {
    const minutes = calculateTotalMinutes(shift, hours);
    return minutes === null ? null : minutes / 60;
  }

  function deriveTotals(input) {
    const values = input || {};
    const shift = normalizeShift(values.shift);
    const grandTotal = roundCent(parseMoney(values.grandTotal));
    let totalAM = 0;
    let totalPM = 0;

    if (shift === "AM") {
      totalAM = grandTotal;
    } else if (shift === "PM") {
      totalPM = grandTotal;
    } else {
      totalAM = roundCent(parseMoney(values.totalAM));
      totalPM = roundCent(grandTotal - totalAM);
    }

    return { shift, grandTotal, totalAM, totalPM };
  }

  function calculateBusser(input) {
    const values = input || {};
    const position = normalizePosition(values.position);
    const totals = deriveTotals(values);
    const busserAM = normalizeBusserAM(values.busserAM);

    if (position === "Bartender") {
      return {
        rate: 0,
        tipOut: 0,
        basis: 0,
        busserAM: "N/A"
      };
    }

    let rate = 0;
    let basis = 0;
    if (totals.shift === "PM") {
      rate = 1.5;
      basis = totals.totalPM;
    } else if (totals.shift === "AM") {
      rate = busserAM === "WITH" ? 1.5 : 0;
      basis = rate ? totals.totalAM : 0;
    } else if (busserAM === "WITH") {
      rate = 1.5;
      basis = totals.grandTotal;
    } else {
      basis = totals.totalPM;
    }

    const tipOut = roundCent(basis * 0.015);
    if (totals.shift === "DOUBLE" && busserAM === "WITHOUT") {
      rate = totals.grandTotal > 0 ? (tipOut / totals.grandTotal) * 100 : 0;
    }

    return {
      rate,
      tipOut,
      basis,
      busserAM: totals.shift === "PM" ? "N/A" : busserAM
    };
  }

  function calculateBarTipOut(input) {
    const values = input || {};
    const position = normalizePosition(values.position);
    const totals = deriveTotals(values);

    if (position === "Bartender") {
      const manual = roundCent(parseMoney(
        values.bartenderBarTipOut !== undefined ? values.bartenderBarTipOut : values.barTipOut
      ));
      return {
        am: 0,
        pm: 0,
        total: manual
      };
    }

    const am = values.amBarSales ? roundCent(totals.totalAM * 0.006) : 0;
    const pm = values.pmBarSales ? roundCent(totals.totalPM * 0.006) : 0;
    return {
      am,
      pm,
      total: roundCent(am + pm)
    };
  }

  function normalizeAdjustmentDecision(value) {
    const decision = String(value || "").trim().toUpperCase();
    if (decision === "ACCEPTED") return "ACCEPTED";
    if (decision === "DECLINED") return "DECLINED";
    if (decision === "DELETED") return "DELETED";
    if (decision === "NONE") return "NONE";
    return "PENDING";
  }

  function parseAdjustmentOverride(value) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "string" && !value.trim()) {
      return null;
    }

    const parsed = parseMoney(value, Number.NaN);
    return Number.isFinite(parsed) && parsed >= 0 ? roundCent(parsed) : null;
  }

  /**
   * Calculates the minimum hourly adjustment without making the employee's
   * decision for them.
   *
   * Eligibility intentionally follows Total Before Meal, while the candidate
   * amount follows Grand Total Tip (which includes Cash Tip):
   *
   *   minimum   = Total Hours x hourly rate
   *   eligible  = Total Before Meal < minimum
   *   candidate = max(0, minimum - Grand Total Tip)
   *
   * A report with a positive candidate starts as PENDING and applies $0.00.
   * ACCEPTED applies the candidate, or an explicitly supplied non-negative
   * override. DECLINED, DELETED and NONE always apply $0.00.
   */
  function calculateHourlyAdjustment(input) {
    const values = input || {};
    const position = normalizePosition(values.position);
    const hourlyRate = position === "Bartender" ? 7 : 7.25;
    const rawMinutes = Number(values.totalMinutesWork);
    const hasExactMinutes = values.totalMinutesWork !== null
      && values.totalMinutesWork !== undefined
      && values.totalMinutesWork !== ""
      && Number.isFinite(rawMinutes)
      && rawMinutes > 0;
    const rawHours = values.totalHoursWork !== undefined
      ? Number(values.totalHoursWork)
      : Number(values.totalHours);
    const hasValidHours = hasExactMinutes || (Number.isFinite(rawHours) && rawHours > 0);
    const totalHoursWork = hasExactMinutes ? rawMinutes / 60 : (hasValidHours ? rawHours : null);
    const hourlyMinimum = hasValidHours ? roundCent(totalHoursWork * hourlyRate) : 0;
    const totalBeforeMeal = roundCent(parseMoney(values.totalBeforeMeal));
    const grandTotalTip = roundCent(parseMoney(values.grandTotalTip));
    const adjustmentEligible = hasValidHours && totalBeforeMeal < hourlyMinimum;
    const adjustmentCandidate = adjustmentEligible
      ? roundCent(Math.max(0, hourlyMinimum - grandTotalTip))
      : 0;
    const hasCandidate = adjustmentEligible && adjustmentCandidate > 0;
    const hasDecision = Object.prototype.hasOwnProperty.call(values, "adjustmentDecision");
    let adjustmentDecision = hasCandidate
      ? (hasDecision ? normalizeAdjustmentDecision(values.adjustmentDecision) : "PENDING")
      : "NONE";

    // NONE is an explicit no-adjustment state. An unknown or blank value is
    // normalized to PENDING only while a real candidate exists.
    if (!hasCandidate) {
      adjustmentDecision = "NONE";
    }

    let overrideValue = null;
    if (Object.prototype.hasOwnProperty.call(values, "adjustmentOverride")) {
      overrideValue = parseAdjustmentOverride(values.adjustmentOverride);
    } else if (Object.prototype.hasOwnProperty.call(values, "adjustmentSalaryHourly")) {
      overrideValue = parseAdjustmentOverride(values.adjustmentSalaryHourly);
    }

    const adjustmentSalaryHourly = adjustmentDecision === "ACCEPTED"
      ? (overrideValue === null ? adjustmentCandidate : overrideValue)
      : 0;

    return {
      hourlyRate,
      hourlyMinimum,
      adjustmentEligible,
      adjustmentCandidate,
      adjustmentDecision,
      adjustmentSalaryHourly: roundCent(adjustmentSalaryHourly)
    };
  }

  function calculateReport(input) {
    const values = input || {};
    const position = normalizePosition(values.position);
    const totals = deriveTotals(values);
    const busser = calculateBusser(Object.assign({}, values, totals, { position }));
    const bar = calculateBarTipOut(Object.assign({}, values, totals, { position }));
    const paidTip = roundCent(parseMoney(
      values.paidTips !== undefined ? values.paidTips : values.paidTip
    ));
    const cardFee = roundCent(parseMoney(
      values.cardFee !== undefined ? values.cardFee : values.payCardTipFee
    ));
    const cashTip = roundCent(parseMoney(values.cashTip));
    const meal = roundCent(parseMoney(values.meal));

    // Paid Tips is already the final receipt Paid Tip. Busser is not subtracted again.
    const totalTips = roundCent(paidTip + cardFee + busser.tipOut);
    const totalBeforeMeal = roundCent(
      position === "Bartender" ? paidTip + bar.total : paidTip - bar.total
    );
    const grandTotalTip = roundCent(totalBeforeMeal + cashTip);
    const totalPaidOutBeforeAdjustment = roundCent(totalBeforeMeal - meal);
    const hours = values.hours || values;
    const clockMinutesWork = calculateTotalMinutes(totals.shift, hours);
    const savedMinutesWork = Number(values.totalMinutesWork);
    const hasSavedMinutes = values.totalMinutesWork !== null
      && values.totalMinutesWork !== undefined
      && values.totalMinutesWork !== ""
      && Number.isInteger(savedMinutesWork)
      && savedMinutesWork >= 0;
    // Valid clocks are authoritative. Exact persisted minutes are the second
    // choice; a legacy decimal-hour value is used only when neither exists.
    const totalMinutesWork = clockMinutesWork !== null
      ? clockMinutesWork
      : (hasSavedMinutes ? savedMinutesWork : null);
    const legacyHoursWork = values.totalHoursWork !== undefined
      ? Number(values.totalHoursWork)
      : Number(values.totalHours);
    const totalHoursWork = totalMinutesWork !== null
      ? totalMinutesWork / 60
      : (Number.isFinite(legacyHoursWork) && legacyHoursWork >= 0 ? legacyHoursWork : null);
    const adjustment = calculateHourlyAdjustment({
      position,
      totalMinutesWork,
      totalHoursWork,
      totalBeforeMeal,
      grandTotalTip,
      adjustmentDecision: values.adjustmentDecision,
      adjustmentOverride: values.adjustmentOverride !== undefined
        ? values.adjustmentOverride
        : values.adjustmentSalaryHourly
    });
    const grandTotalAfterAdjustment = roundCent(
      grandTotalTip + adjustment.adjustmentSalaryHourly
    );
    // This separate APK intentionally uses the new payout formula. Cash Tip is
    // already part of Grand Total Tip and therefore part of Total Paid Out.
    const totalPaidOut = roundCent(grandTotalAfterAdjustment - meal);

    return {
      date: values.date || "",
      employee: values.employee || values.name || "",
      position,
      shift: totals.shift,
      busserAM: busser.busserAM,
      hourIn: hours.hourIn || "",
      hourOut: hours.hourOut || "",
      hourInAM: hours.hourInAM || "",
      hourOutAM: hours.hourOutAM || "",
      hourInPM: hours.hourInPM || "",
      hourOutPM: hours.hourOutPM || "",
      totalMinutesWork,
      totalHoursWork,
      grandTotal: totals.grandTotal,
      totalAM: totals.totalAM,
      totalPM: totals.totalPM,
      totalTips,
      payCardTipFee: cardFee,
      paidTip,
      paidTips: paidTip,
      busserRate: busser.rate,
      busserTipOut: busser.tipOut,
      totalShared: busser.tipOut,
      amBarSales: Boolean(values.amBarSales),
      pmBarSales: Boolean(values.pmBarSales),
      amBarTipOut: bar.am,
      pmBarTipOut: bar.pm,
      barTipOut: bar.total,
      totalBeforeMeal,
      cashTip,
      grandTotalTip,
      hourlyRate: adjustment.hourlyRate,
      hourlyMinimum: adjustment.hourlyMinimum,
      adjustmentEligible: adjustment.adjustmentEligible,
      adjustmentCandidate: adjustment.adjustmentCandidate,
      adjustmentDecision: adjustment.adjustmentDecision,
      adjustmentSalaryHourly: adjustment.adjustmentSalaryHourly,
      grandTotalAfterAdjustment,
      meal,
      totalPaidOutBeforeAdjustment,
      totalPaidOut
    };
  }

  return Object.freeze({
    roster,
    roundCent,
    parseMoney,
    formatTimeDigits,
    parseTypedTime,
    to24Hour,
    calculateTotalMinutes,
    calculateTotalHours,
    deriveTotals,
    calculateBusser,
    calculateBarTipOut,
    calculateHourlyAdjustment,
    calculateReport
  });
});
