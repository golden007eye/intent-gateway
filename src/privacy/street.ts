// The street words both identity scans share: the default street_address rule (index.ts) and the free-text rules of a
// tool input (freetext.ts).

/** US street types, as the default street_address rule has always read them. */
export const SUFFIXES = [
  "St", "Street", "Ave", "Av", "Avenue", "Rd", "Road", "Blvd", "Boulevard", "Ln", "Lane", "Dr", "Drive",
  "Ct", "Court", "Way", "Pl", "Place", "Ter", "Terrace", "Pkwy", "Parkway", "Hwy", "Highway", "Cir", "Circle",
];
export const STREET_WORD = String.raw`(?:[A-Za-z][A-Za-z'.-]*|\d+(?:st|nd|rd|th))`;
/** A number followed by a quantity word ("4 Wheel Drive", "2 Pack Way") is a quantity, not a house number. */
export const QUANTITY_WORDS = ["wheel", "pack", "piece", "pc", "pcs", "count", "ct", "inch", "in", "ft", "oz", "lb", "x"];
/** A house number, or a range of them ("221B", "12-14"), not glued to a word, "_" or "-" before it. */
export const HOUSE_NUMBER = String.raw`(?<![\w-])\d{1,6}[A-Za-z]?(?:\s*[-‐-―−]\s*\d{1,6}[A-Za-z]?)?`;
